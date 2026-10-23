import * as React from "react";
import { CircleAlert, CircleCheck, Mail, MailCheck, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import type { PublicProposalView } from "@/server/proposals/public";

// How the customer answers. Every form posts to the proposals API and works without JavaScript. Nothing here claims more than what is recorded: an answer given with a code is
// "a recorded answer", never a signature, and the business hears about it in the same words.

export interface Notice {
  tone: "ok" | "error";
  text: string;
}

const inputClass =
  "w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[16px] leading-relaxed text-ink shadow-soft outline-none transition placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 sm:text-sm";
export const linkClass =
  "inline-flex h-11 min-w-0 select-none items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10";

export function NoticeBanner({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const ok = notice.tone === "ok";
  return (
    <p role={ok ? "status" : "alert"} className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-[13.5px] ${ok ? "border-success/25 bg-success-soft text-success-ink" : "border-danger/20 bg-danger-soft text-danger-ink"}`}>
      {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span>{notice.text}</span>
    </p>
  );
}

export function ContactLinks({ business }: { business: NonNullable<PublicProposalView["business"]> }) {
  if (!business.contactEmail && !business.contactPhone) return null;
  return (
    <div className="flex flex-wrap gap-2">
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

function day(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

function Answered({ view }: { view: PublicProposalView }) {
  const a = view.answer;
  const business = view.business;
  if (!a || !business) return null;
  const when = day(a.decidedAt, business.timezone);
  const verb = a.decision === "accepted" ? "accepted" : "declined";
  const how =
    a.method === "recorded_by_staff"
      ? `${business.name} recorded this answer on ${when}. It was not verified through this page.`
      : a.method === "provider_signature"
        ? `You signed this proposal through a signing service on ${when}.`
        : `You ${verb} this proposal on ${when}. It was recorded with the email address ${a.emailMasked ?? "you confirmed"}, which you confirmed with a code. That is a record of your answer, not an electronic signature.`;
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">Your answer</h2>
      <div role="status" className="mt-3 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success-ink">
          <CircleCheck className="size-4.5" aria-hidden />
        </span>
        <p className="text-[14px] leading-relaxed text-ink-2">
          {a.decision === "accepted" ? "Accepted." : "Declined."} {how} {business.name} has been told.
        </p>
      </div>
    </Card>
  );
}

export function AnswerPanel({ token, view, code, result }: { token: string; view: PublicProposalView; code: Notice | null; result: Notice | null }) {
  if (view.state === "answered") return <Answered view={view} />;
  const business = view.business;
  const proposal = view.proposal;
  if (view.state !== "open" || !business || !proposal) return null;
  const api = (action: string) => `/api/public/proposals/${token}/${action}`;
  const masked = view.recipient.maskedEmail;

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">Your answer</h2>
      <div className="mt-3 space-y-4">
        <NoticeBanner notice={result} />
        {!masked ? (
          <div className="space-y-3">
            <p className="text-[14px] leading-relaxed text-ink-2">{business.name} has no email address on file for you, so this proposal can&apos;t be answered on this page. Contact them to accept, decline or ask for changes.</p>
            <ContactLinks business={business} />
          </div>
        ) : !view.verified ? (
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-ink-2">
              To answer, first confirm your email address. We&apos;ll send a 6-digit code to <strong className="font-semibold text-ink">{masked}</strong>. Entering it shows that you can read that mailbox. It is not a signature.
            </p>
            <NoticeBanner notice={code} />
            <form method="post" action={api("code")}>
              <Button type="submit" variant="secondary" className="w-full sm:w-auto">
                <Mail className="size-4" aria-hidden />
                Email me a code
              </Button>
            </form>
            <form method="post" action={api("verify")} className="space-y-2">
              <label htmlFor="proposal-code" className="text-[13.5px] font-medium text-ink-2">6-digit code</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="proposal-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 \-]*" maxLength={12} required className={`${inputClass} sm:max-w-[12rem]`} />
                <Button type="submit" className="w-full sm:w-auto">Confirm</Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-5">
            <p role="status" className="flex items-start gap-2 text-[13.5px] text-success-ink">
              <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>Email confirmed: {view.verified.emailMasked}</span>
            </p>
            {view.changeRequests > 0 && <p className="text-[13.5px] text-muted">You have asked {business.name} for changes {view.changeRequests === 1 ? "once" : `${view.changeRequests} times`}. They will get back to you. You can still answer here.</p>}
            {proposal.requiresSignature ? (
              <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
                This proposal is accepted by signature, which {business.name} arranges separately. It can&apos;t be accepted on this page. Contact them to sign.
              </p>
            ) : (
              <form method="post" action={api("decide")} className="space-y-3">
                <input type="hidden" name="decision" value="accept" />
                <input type="hidden" name="h" value={proposal.contentHash} />
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-[14px] leading-relaxed text-ink-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
                  <input type="checkbox" name="ack" value="1" required className="mt-1 size-5 shrink-0 accent-primary" />
                  <span>{view.acknowledgement?.text}</span>
                </label>
                <Button type="submit" variant="brand" className="w-full sm:w-auto">Accept this proposal</Button>
              </form>
            )}
            <form method="post" action={api("decide")} className="space-y-2 border-t border-line pt-4">
              <input type="hidden" name="decision" value="request_changes" />
              <input type="hidden" name="h" value={proposal.contentHash} />
              <label htmlFor="proposal-changes" className="text-[13.5px] font-medium text-ink-2">Ask for changes</label>
              <textarea id="proposal-changes" name="note" required minLength={3} maxLength={2000} rows={3} placeholder="What would you like changed?" className={`${inputClass} min-h-[88px] resize-y`} />
              <Button type="submit" variant="secondary" className="w-full sm:w-auto">Send to {business.name}</Button>
            </form>
            <form method="post" action={api("decide")} className="space-y-2 border-t border-line pt-4">
              <input type="hidden" name="decision" value="decline" />
              <input type="hidden" name="h" value={proposal.contentHash} />
              <label htmlFor="proposal-decline" className="text-[13.5px] font-medium text-ink-2">Decline <span className="font-normal text-faint">Optional note</span></label>
              <textarea id="proposal-decline" name="note" maxLength={2000} rows={2} className={`${inputClass} min-h-[64px] resize-y`} />
              <Button type="submit" variant="outline" className="w-full sm:w-auto">Decline this proposal</Button>
            </form>
          </div>
        )}
      </div>
    </Card>
  );
}
