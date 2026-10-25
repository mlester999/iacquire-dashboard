"use client";

import * as React from "react";
import { CheckCircle2, HeartHandshake, Loader2, Send, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { answerSupportSurveyAction } from "@/app/actions/support";
import { cn } from "@/lib/utils";
import type { SurveyView } from "@/lib/support/surveys";

/**
 * One question, asked once, inside the request it is about. The customer chooses a rating and whether the reply helped, may add a
 * sentence, and sends it themselves. Nothing is pre-selected and nothing is submitted automatically.
 */
function SurveyThanks() {
  return (
    <section aria-live="polite" className="rounded-2xl border border-success/25 bg-success-soft/60 p-5">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-success-ink"><CheckCircle2 className="size-4" aria-hidden /> Thank you — your answer was recorded.</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-2">It stays with this request for the team to learn from. You can close this page.</p>
    </section>
  );
}

/**
 * Where the question lives on a request page. Saving an answer makes the page read again, and a request whose question was answered no longer has one, so the card itself is
 * gone by the time the answer comes back: the thank-you has to be held by something that stays. (A browser run found this: every unit test kept the card mounted, and the real
 * page showed nothing at all after "Send my answer".)
 */
export function SupportSurveyArea({ survey }: { survey: SurveyView | null }) {
  const [thanked, setThanked] = React.useState(false);
  if (thanked) return <SurveyThanks />;
  return survey ? <SupportSurveyCard survey={survey} onAnswered={() => setThanked(true)} /> : null;
}

export function SupportSurveyCard({ survey, onAnswered }: { survey: SurveyView; onAnswered?: () => void }) {
  const [rating, setRating] = React.useState(0);
  const [helpful, setHelpful] = React.useState<boolean | null>(null);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const canSend = rating > 0 && helpful !== null && !busy;

  async function submit() {
    if (!canSend) return;
    setBusy(true);
    try {
      const r = await answerSupportSurveyAction(survey.id, { rating, helpful: helpful as boolean, comment });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDone(true);
      onAnswered?.();
    } catch {
      toast.error("Your answer could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <SurveyThanks />;

  return (
    <section aria-labelledby={`survey-${survey.id}`} className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary-soft/85 via-surface to-surface p-5 shadow-card sm:p-6">
      <div className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-primary/10 blur-2xl" aria-hidden />
      <div className="relative flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-white shadow-soft" aria-hidden><HeartHandshake className="size-5" /></span>
        <div className="min-w-0">
          <h2 id={`survey-${survey.id}`} className="text-[17px] font-semibold tracking-tight text-ink">How did we do?</h2>
          <p className="mt-1 max-w-xl text-[14px] leading-relaxed text-ink-2">This request is resolved. One quick answer helps the team know what worked and what to improve.</p>
        </div>
      </div>

      <fieldset className="relative mt-5">
        <legend className="text-[14px] font-medium text-ink-2">How satisfied are you?</legend>
        <div role="radiogroup" aria-label="How satisfied are you" className="mt-2 flex flex-wrap gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} out of 5`} onClick={() => setRating(n)}
              className={cn("grid size-11 place-items-center rounded-xl border text-[14px] font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                rating >= n ? "border-primary/40 bg-primary text-white shadow-soft" : "border-line-strong bg-surface text-muted hover:border-primary/40 hover:text-primary-ink")}>
              <Star className={cn("size-4", rating >= n ? "fill-current" : "")} aria-hidden />
              <span className="sr-only">{n} out of 5</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="relative mt-4">
        <legend className="text-[14px] font-medium text-ink-2">Did the reply help?</legend>
        <div role="radiogroup" aria-label="Did the reply help" className="mt-2 flex gap-2">
          {([true, false] as const).map((v) => (
            <button key={String(v)} type="button" role="radio" aria-checked={helpful === v} onClick={() => setHelpful(v)}
              className={cn("min-h-10 rounded-xl border px-4 text-[14px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                helpful === v ? "border-primary bg-primary text-white shadow-soft" : "border-line-strong bg-surface text-ink-2 hover:border-primary/40 hover:text-ink")}>
              {v ? "Yes, it helped" : "Not really"}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="relative mt-4">
        <label htmlFor={`survey-comment-${survey.id}`} className="text-[14px] font-medium text-ink-2">Anything you&apos;d like to add? <span className="font-normal text-muted">Optional</span></label>
        <Textarea id={`survey-comment-${survey.id}`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={3} placeholder="A sentence for the team…" className="mt-1.5" />
      </div>

      <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted">Only you can answer this, and once. It is not sent by email or text.</p>
        <Button type="button" variant="brand" disabled={!canSend} onClick={() => void submit()} className="min-h-11">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} {busy ? "Sending…" : "Send my answer"}
        </Button>
      </div>
    </section>
  );
}
