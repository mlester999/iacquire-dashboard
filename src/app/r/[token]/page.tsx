import type { Metadata } from "next";
import { CircleAlert, CircleCheck, ExternalLink, Hourglass, Link2Off, Lock, Mail, MessageSquareHeart, Phone, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { Monogram } from "@/app/book/_components/shell";
import { FEEDBACK_COMMENT_MAX, loadReviewPage, type ReviewPageView } from "@/server/crm/reviews";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your feedback", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Business = NonNullable<ReviewPageView["business"]>;

const RATINGS = [
  { value: 1, label: "Poor" },
  { value: 2, label: "Fair" },
  { value: 3, label: "Good" },
  { value: 4, label: "Very good" },
  { value: 5, label: "Excellent" },
];

/** The zero-to-ten question's buttons. */
const NPS_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const choiceClass =
  "cursor-pointer rounded-xl border border-line bg-surface shadow-soft transition-colors hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:checked]:text-primary-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary";

const RESULTS: Record<string, { tone: "ok" | "error"; text: string }> = {
  saved: { tone: "ok", text: "Thank you. Your feedback was sent." },
  already: { tone: "ok", text: "Your feedback was already sent. Thank you." },
  empty: { tone: "error", text: "Choose a rating or write a few words before sending." },
  invalid: { tone: "error", text: "Something in the form wasn't right. Please try again." },
  closed: { tone: "error", text: "This link no longer accepts feedback." },
  rate_limited: { tone: "error", text: "Too many attempts in a short while. Wait a few minutes, then try again." },
  unavailable: { tone: "error", text: "Feedback was unavailable for a moment, so nothing was sent. Please try again." },
  link_missing: { tone: "error", text: "That review link isn't available any more. Use one of the links below." },
  error: { tone: "error", text: "That didn't go through. Please try again." },
};

const linkClass =
  "inline-flex h-11 min-w-0 select-none items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10";

function Shell({ business, children }: { business: Business | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#review-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float">
        Skip to content
      </a>
      {business && (
        <header className="mx-auto w-full max-w-2xl px-4 pt-6 sm:px-6 sm:pt-12">
          <div className="flex min-w-0 items-center gap-3">
            <Monogram name={business.name} color={business.brandColor} />
            <p className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{business.name}</p>
          </div>
        </header>
      )}
      <main id="review-main" tabIndex={-1} className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="mx-auto w-full max-w-2xl px-4 pb-8 pt-2 text-center text-[12px] text-muted sm:px-6">Feedback by iAcquire</footer>
    </div>
  );
}

function Notice({ icon: Icon, title, children }: { icon: typeof Link2Off; title: string; children: React.ReactNode }) {
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

/**
 * The public review links. Rendered the same way for every customer and every rating: nothing on this page decides who sees them.
 * While the link is open each one posts to /api/public/reviews/click (which records the click and redirects); afterwards they are plain
 * links. Both work without JavaScript.
 */
function PublicReviews({ view, token }: { view: ReviewPageView; token: string }) {
  const business = view.business!;
  return (
    <section aria-labelledby="public-reviews" className="space-y-3">
      <div>
        <h2 id="public-reviews" className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.02em] text-ink">
          <Star className="size-4 text-primary" aria-hidden />
          Leave a public review
        </h2>
        <p className="mt-1 text-[14px] leading-relaxed text-muted">
          If you&apos;d like to tell others about your experience, you can review {business.name} on the site of your choice. It&apos;s entirely up to you, and these links are the same for everyone, whatever you tell us below.
        </p>
      </div>
      {view.destinations.length ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Review sites">
          {view.destinations.map((d) => (
            <li key={d.id}>
              {view.state === "open" ? (
                <form method="post" action="/api/public/reviews/click">
                  <input type="hidden" name="t" value={token} />
                  <input type="hidden" name="d" value={d.id} />
                  <button type="submit" className={`${linkClass} w-full justify-between`}>
                    <span className="truncate">{d.label}</span>
                    <ExternalLink className="size-4 shrink-0 text-muted" aria-hidden />
                  </button>
                </form>
              ) : (
                <a href={d.url} rel="noopener noreferrer" target="_blank" className={`${linkClass} w-full justify-between`}>
                  <span className="truncate">{d.label}</span>
                  <ExternalLink className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-muted">{business.name} hasn&apos;t added a public review site yet.</p>
      )}
    </section>
  );
}

function ContactLinks({ business }: { business: Business }) {
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

/** One to five, with a word under each number. */
function StarScale() {
  return (
    <fieldset>
      <legend className="text-[14px] font-medium text-ink-2">How was your experience?</legend>
      <div className="mt-2 grid grid-cols-5 gap-1.5 sm:gap-2">
        {RATINGS.map((r) => (
          <label key={r.value} className={`${choiceClass} flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-2 text-center`}>
            <input type="radio" name="rating" value={r.value} className="sr-only" />
            <span className="text-[16px] font-semibold tabular-nums">{r.value}</span>
            <span className="text-[12px] leading-tight text-muted sm:text-[12px]">{r.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Zero to ten: how likely the customer is to recommend the business. The ends are named; nothing in between is. */
function RecommendScale({ business }: { business: Business }) {
  return (
    <fieldset>
      <legend className="text-[14px] font-medium text-ink-2">How likely are you to recommend {business.name} to a friend or colleague?</legend>
      <div className="mt-2 grid grid-cols-6 gap-1.5 sm:grid-cols-11 sm:gap-2">
        {NPS_VALUES.map((n) => (
          <label key={n} className={`${choiceClass} flex min-h-12 items-center justify-center px-1 py-2 text-center`}>
            <input type="radio" name="rating" value={n} className="sr-only" />
            <span className="text-[16px] font-semibold tabular-nums">{n}</span>
          </label>
        ))}
      </div>
      <p className="mt-1.5 flex justify-between gap-3 text-[12px] leading-tight text-muted">
        <span>0 is not at all likely</span>
        <span className="text-right">10 is extremely likely</span>
      </p>
    </fieldset>
  );
}

function FeedbackForm({ token, business, scale, result }: { token: string; business: Business; scale: ReviewPageView["scale"]; result: { tone: "ok" | "error"; text: string } | null }) {
  return (
    <form method="post" action="/api/public/reviews/feedback" className="mt-4 space-y-4">
      <input type="hidden" name="t" value={token} />
      {scale === "nps10" ? <RecommendScale business={business} /> : <StarScale />}
      <div className="space-y-1.5">
        <label htmlFor="review-comment" className="text-[14px] font-medium text-ink-2">Anything you&apos;d like {business.name} to know? <span className="font-normal text-faint">Optional</span></label>
        <textarea
          id="review-comment"
          name="comment"
          maxLength={FEEDBACK_COMMENT_MAX}
          rows={4}
          className="min-h-[104px] w-full resize-y rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] leading-relaxed text-ink shadow-soft outline-none transition placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 sm:text-sm"
        />
      </div>
      {result?.tone === "error" && (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{result.text}</span>
        </p>
      )}
      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Goes privately to {business.name}. It isn&apos;t posted anywhere.
        </p>
        <Button type="submit" className="w-full sm:w-auto">
          <MessageSquareHeart className="size-4" aria-hidden />
          Send feedback
        </Button>
      </div>
    </form>
  );
}

/**
 * Where a customer lands from a review request. Two separate things, both always on the page: the business's public review links, and
 * a private feedback form that goes only to the business. Opening the page records that the request was opened; nothing a customer
 * says privately changes which public links they see. Works without JavaScript.
 */
export default async function ReviewRequestPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string | string[] }> }) {
  const { token } = await params;
  const r = (await searchParams).r;
  const result = typeof r === "string" ? RESULTS[r] ?? null : null;
  const view = await loadReviewPage(token);

  // The platform-wide emergency switch: the same plain notice for every address, valid or not, and nothing about the business (nothing was read).
  if (view.state === "disabled") {
    return (
      <Shell business={null}>
        <Notice icon={Hourglass} title="Feedback is temporarily unavailable">
          <p>Please try again later, or contact the business directly.</p>
        </Notice>
      </Shell>
    );
  }
  if (view.state === "rate_limited") {
    return (
      <Shell business={null}>
        <Notice icon={Hourglass} title="One moment, please">
          <p>This link has been opened many times in a short while. Wait a few minutes, then open it again.</p>
        </Notice>
      </Shell>
    );
  }
  if (view.state === "invalid" || !view.business) {
    return (
      <Shell business={null}>
        <Notice icon={Link2Off} title="This link isn't valid">
          <p>It may have been cut short when it was copied. Open the link straight from the message you received.</p>
        </Notice>
      </Shell>
    );
  }
  const business = view.business;
  const given = Boolean(view.feedback) || r === "saved" || r === "already";
  // Errors from the form show inside it; anything else (a review link that went away) shows at the top.
  const topAlert = result?.tone === "error" && (given || view.state === "closed" || r === "link_missing") ? result : null;

  return (
    <Shell business={business}>
      <div className="space-y-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink sm:text-[26px]">Thanks for choosing {business.name}</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">We&apos;d love to hear how it went.</p>
        </div>
        {topAlert && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-[14px] text-danger-ink">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{topAlert.text}</span>
          </p>
        )}

        {(view.destinations.length > 0 || view.kind === "review") && (
          <Card className="p-5 sm:p-6">
            <PublicReviews view={view} token={token} />
          </Card>
        )}

        <Card className="p-5 sm:p-6">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-[-0.02em] text-ink">
            <MessageSquareHeart className="size-4 text-primary" aria-hidden />
            Send private feedback
          </h2>
          {given ? (
            <div role="status" className="mt-3 flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success-ink">
                <CircleCheck className="size-4.5" aria-hidden />
              </span>
              <p className="text-[14px] leading-relaxed text-ink-2">
                {result?.tone === "ok" ? result.text : "Your feedback was sent. Thank you."} Only {business.name} sees it.{view.feedback?.followUp ? ` Someone from ${business.name} will also follow up with you privately.` : ""} The review links above stay open to you either way.
              </p>
            </div>
          ) : view.state === "closed" ? (
            <div className="mt-3 space-y-3">
              <p className="text-[14px] leading-relaxed text-muted">
                {view.closedReason === "expired" ? "This link has expired, so it no longer takes feedback." : "This request was withdrawn, so it no longer takes feedback."} You can still reach {business.name} directly:
              </p>
              <ContactLinks business={business} />
            </div>
          ) : (
            <FeedbackForm token={token} business={business} scale={view.scale} result={topAlert ? null : result} />
          )}
        </Card>
      </div>
    </Shell>
  );
}
