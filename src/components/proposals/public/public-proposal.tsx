import * as React from "react";
import { Download, Hourglass, Link2Off, Lock } from "lucide-react";
import { Monogram } from "@/app/book/_components/shell";
import { CODE_TEXT, DECIDE_TEXT, PUBLIC_STATE_TEXT, type CodeOutcome, type DecideOutcome } from "@/lib/proposals/share";
import { formatDay } from "@/lib/proposals/validity";
import type { PublicProposalView } from "@/server/proposals/public";
import { AnswerPanel, ContactLinks, NoticeBanner, linkClass, type Notice } from "@/components/proposals/public/answer-panel";
import { ProposalDocument } from "@/components/proposals/public/document";
import { ViewBeacon } from "@/components/proposals/public/view-beacon";

// The customer's page for a proposal link: no portal shell, no sign-in. Rendered from the service's view only, so it shows exactly what the link allows and nothing it does not.

type Business = NonNullable<PublicProposalView["business"]>;

function Shell({ business, children }: { business: Business | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#proposal-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
        Skip to content
      </a>
      {business && (
        <header className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6 sm:pt-10">
          <div className="flex min-w-0 items-center gap-3">
            <Monogram name={business.name} color={business.brandColor} />
            <p className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{business.name}</p>
          </div>
        </header>
      )}
      <main id="proposal-main" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 pt-2 text-center text-[12px] text-muted sm:px-6">Proposals by iAcquire</footer>
    </div>
  );
}

function Message({ icon: Icon, title, children }: { icon: typeof Link2Off; title: string; children: React.ReactNode }) {
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

/** The result of what the customer just did, from the address's `r` and `c` words. Only words this page knows are shown; anything else is ignored. */
export function noticeFor(kind: "r" | "c", word: string | undefined, attemptsLeft?: string): Notice | null {
  if (!word) return null;
  if (kind === "r") return Object.hasOwn(DECIDE_TEXT, word) ? DECIDE_TEXT[word as DecideOutcome] : null;
  if (!Object.hasOwn(CODE_TEXT, word)) return null;
  const n = CODE_TEXT[word as CodeOutcome];
  const left = Number(attemptsLeft);
  return word === "wrong" && Number.isInteger(left) && left >= 0 && left <= 5 ? { ...n, text: `${n.text} You have ${left} ${left === 1 ? "try" : "tries"} left for this code.` } : n;
}

export function PublicProposal({ token, view, result, code }: { token: string; view: PublicProposalView; result: Notice | null; code: Notice | null }) {
  const business = view.business;
  if (view.state !== "open" && view.state !== "answered") {
    const text = PUBLIC_STATE_TEXT[view.state];
    return (
      <Shell business={business}>
        <Message icon={view.state === "rate_limited" ? Hourglass : Link2Off} title={text.title}>
          <p>{text.body}</p>
          {business && view.state !== "invalid" && view.state !== "disabled" && view.state !== "rate_limited" && <div className="flex justify-center"><ContactLinks business={business} /></div>}
        </Message>
      </Shell>
    );
  }
  const proposal = view.proposal;
  if (!proposal || !business) return null;
  return (
    <Shell business={business}>
      <div className="space-y-5">
        {/* Errors from the answer forms show inside the answer panel; anything that has no panel (an answered proposal) shows here. */}
        {view.state === "answered" && <NoticeBanner notice={result} />}
        {proposal.validity === "last_day" && view.state === "open" && <p className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink">Today is the last day this proposal can be accepted{proposal.snapshot.validUntil ? ` (valid until ${formatDay(proposal.snapshot.validUntil)})` : ""}.</p>}
        <div className="card-surface rounded-2xl p-5 sm:p-8">
          <ProposalDocument snapshot={proposal.snapshot} version={proposal.version} />
          <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This page is private to you. Anyone with the address can read it, so don&apos;t share it.
            </p>
            <a href={`/proposal/${token}/pdf`} download className={`${linkClass} w-full sm:w-auto`}>
              <Download className="size-4" aria-hidden />
              Download PDF
            </a>
          </div>
        </div>
        <AnswerPanel token={token} view={view} code={code} result={view.state === "open" ? result : null} />
      </div>
      <ViewBeacon token={token} />
    </Shell>
  );
}
