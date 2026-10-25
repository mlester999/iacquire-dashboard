"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { FeedbackMessage, FeedbackStatus, FeedbackValue } from "./use-message-feedback";

const REASONS = ["Incorrect information", "Didn't understand my question", "Not helpful", "Too much information", "Outdated information", "Other"];
const PARTICLES = [[-25, -23], [-12, -34], [5, -36], [26, -25], [32, -3], [-30, 5]];

export function AqiMessageFeedback({ message, status, onChange, onRetry }: {
  message: FeedbackMessage;
  status?: FeedbackStatus;
  onChange: (message: FeedbackMessage, rating: FeedbackValue["rating"], comment?: string | null) => void;
  onRetry: (message: FeedbackMessage) => void;
}) {
  const reduced = useReducedMotion();
  const detailsId = React.useId();
  const dislikeRef = React.useRef<HTMLButtonElement>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [text, setText] = React.useState("");
  const [reaction, setReaction] = React.useState<{ rating: 1 | -1; key: number } | null>(null);
  const rating = message.feedbackRating;

  function react(rating: 1 | -1) {
    if (!reduced) setReaction((current) => ({ rating, key: (current?.key ?? 0) + 1 }));
  }

  function closeDetails() {
    setDetailsOpen(false);
    dislikeRef.current?.focus();
  }

  return <>
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      <span className="relative isolate inline-flex">
        <button type="button" title={rating === 1 ? "Remove helpful feedback" : "Mark helpful"}
          onClick={() => { setDetailsOpen(false); onChange(message, rating === 1 ? null : 1); if (rating !== 1) react(1); else setReaction(null); }}
          className={cn("relative z-10 flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", rating === 1 && "bg-success-soft text-success-ink hover:bg-success-soft hover:text-success-ink")}
          aria-label={rating === 1 ? "Remove helpful feedback" : "Helpful"} aria-pressed={rating === 1}>
          <motion.span key={reaction?.rating === 1 ? reaction.key : "like"} className="inline-flex"
            animate={!reduced && reaction?.rating === 1 ? { scale: [1, 1.3, 0.95, 1], rotate: [0, -12, 5, 0] } : { scale: 1, rotate: 0 }} transition={{ duration: 0.35 }}>
            <ThumbsUp className="size-3.5" />
          </motion.span>
        </button>
        {!reduced && reaction?.rating === 1 && <motion.span key={reaction.key} aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 grid place-items-center" initial={{ opacity: 1 }} animate={{ opacity: [1, 1, 0] }} transition={{ duration: 0.75, times: [0, 0.8, 1] }} onAnimationComplete={() => setReaction(null)}>
          <motion.span className="absolute size-6 rounded-full border border-success-ink/35" initial={{ scale: 0.5, opacity: 0.7 }} animate={{ scale: 1.8, opacity: 0 }} transition={{ duration: 0.5 }} />
          {PARTICLES.map(([x, y], index) => <motion.span key={index}
            className={cn("absolute h-1.5 w-1 rounded-sm", index % 2 ? "bg-primary" : "bg-success-ink")}
            initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }} animate={{ x, y, opacity: [0, 1, 0], scale: [0.4, 1, 0.3], rotate: index * 65 }}
            transition={{ duration: 0.6, delay: index * 0.012 }} />)}
        </motion.span>}
      </span>
      <span className="relative isolate inline-flex">
        <button ref={dislikeRef} type="button" title={rating === -1 ? "Remove not-helpful feedback" : "Not helpful"}
          onClick={() => {
            if (rating === -1) { onChange(message, null); setDetailsOpen(false); setReaction(null); }
            else { onChange(message, -1); react(-1); setDetailsOpen(true); setReason(""); setText(""); }
          }}
          className={cn("relative z-10 flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40", rating === -1 && "bg-danger-soft text-danger-ink hover:bg-danger-soft hover:text-danger-ink")}
          aria-label={rating === -1 ? "Remove not-helpful feedback" : "Not helpful"} aria-pressed={rating === -1} aria-expanded={detailsOpen} aria-controls={detailsOpen ? detailsId : undefined}>
          <motion.span key={reaction?.rating === -1 ? reaction.key : "dislike"} className="inline-flex"
            animate={!reduced && reaction?.rating === -1 ? { y: [0, 3, 0], rotate: [0, 12, -5, 0] } : { y: 0, rotate: 0 }} transition={{ duration: 0.3 }}>
            <ThumbsDown className="size-3.5" />
          </motion.span>
        </button>
        {!reduced && reaction?.rating === -1 && <motion.span key={reaction.key} aria-hidden="true" className="pointer-events-none absolute inset-1 rounded-full border border-danger-ink/30" initial={{ scale: 0.7, opacity: 0.6 }} animate={{ scale: 1.5, opacity: 0 }} transition={{ duration: 0.4 }} onAnimationComplete={() => setReaction(null)} />}
      </span>
      <span role="status" aria-live="polite" className="ml-1 inline-flex min-h-6 items-center gap-1.5 text-[12px]">
        {!status?.error && rating !== null && <motion.span key={rating} initial={reduced ? false : { opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }} className={rating === 1 ? "text-success-ink" : "text-muted"}>
          {rating === 1 ? "Glad that helped!" : "Thanks for telling us."}
        </motion.span>}
        {status?.pending && <span className="inline-flex items-center gap-1 text-faint"><span aria-hidden="true" className="size-1 rounded-full bg-current motion-safe:animate-pulse" /><span className="sr-only">Saving feedback</span></span>}
        {status?.error && <span className="text-danger-ink">Couldn&apos;t save feedback.</span>}
      </span>
      {status?.error && <button type="button" onClick={() => onRetry(message)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><RotateCcw className="size-3" />Retry feedback</button>}
      {rating === -1 && !detailsOpen && !status?.error && <button type="button" onClick={() => { setDetailsOpen(true); setReason(""); setText(message.feedbackComment ?? ""); }} className="min-h-8 rounded-lg px-2 text-[12px] font-medium text-muted hover:bg-surface-2 hover:text-ink">Add details</button>}
    </div>
    {detailsOpen && rating === -1 && <form id={detailsId} className="mt-2 w-full basis-full space-y-2 rounded-xl border border-line bg-surface-2/50 p-2.5" onSubmit={(event) => {
      event.preventDefault();
      onChange(message, -1, [reason, text.trim()].filter(Boolean).join(" — ").slice(0, 1000) || null);
      closeDetails();
    }}>
      <p className="text-[12px] font-medium text-ink-2">What could I improve? <span className="font-normal text-muted">Optional</span></p>
      <div className="flex flex-wrap gap-1">{REASONS.map((item) => <button key={item} type="button" aria-pressed={reason === item} onClick={() => setReason(reason === item ? "" : item)} className={cn("rounded-full border px-2 py-1 text-[12px] transition-colors", reason === item ? "border-primary/30 bg-primary-soft text-primary" : "border-line text-muted hover:bg-surface-2")}>{item}</button>)}</div>
      <Textarea rows={2} maxLength={900} value={text} onChange={(event) => setText(event.target.value)} placeholder="Anything else? (optional)" aria-label="Feedback about this answer" className="min-h-12 text-[12px]" />
      <div className="flex gap-1.5"><Button type="submit" size="sm" variant="secondary" disabled={!reason && !text.trim()}>Send details</Button><Button type="button" size="sm" variant="ghost" onClick={closeDetails}>Skip</Button></div>
    </form>}
  </>;
}
