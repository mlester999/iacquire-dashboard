"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, CircleHelp, ExternalLink, Loader2, Pause, Play, RotateCcw, ShieldCheck, SkipForward, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compileCompletionPattern } from "@/lib/aqi/tutorials";
import { cn } from "@/lib/utils";
import {
  closeTutorial,
  confirmTutorialCompletion,
  pauseAndClose,
  rememberGuidanceFocus,
  reportTargetMissing,
  retryTutorialAction,
  setTargetState,
  tutorialActions,
  useGuidance,
} from "@/components/aqi/tutorial/tutorial-store";
import { findVisibleTarget, normalizePath, placeTooltip, routeMatches, scrollTargetIntoView, subscribeToTarget, type Placement, type TargetHit } from "@/components/aqi/tutorial/target-observer";

const CARD_WIDTH = 360;

export function TutorialStage() {
  const state = useGuidance();
  const pathname = usePathname();
  const router = useRouter();
  const reduced = useReducedMotion();
  const [hit, setHit] = React.useState<TargetHit | null>(null);
  const [waiting, setWaiting] = React.useState(false);
  const [missing, setMissing] = React.useState(false);
  const [retryKey, setRetryKey] = React.useState(0);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const [mobile, setMobile] = React.useState(false);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const completedRef = React.useRef<string | null>(null);
  const viewedRef = React.useRef<string | null>(null);
  const advancingRef = React.useRef(false);

  const tutorial = state.tutorial;
  const step = tutorial?.steps[Math.min(state.stepIndex, Math.max(0, (tutorial?.steps.length ?? 1) - 1))] ?? null;
  const cleanPath = normalizePath(pathname);
  const routeMismatch = Boolean(step?.route && !routeMatches(step.route, cleanPath));
  const effectivePhase = state.phase;

  React.useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 640);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Body marker raises the AQi panel above the spotlight so people can ask a question mid-tutorial.
  React.useEffect(() => {
    if (!state.open) return;
    document.body.dataset.aqiTutorial = "on";
    return () => {
      delete document.body.dataset.aqiTutorial;
    };
  }, [state.open]);

  React.useEffect(() => {
    if (!state.open) return;
    rememberGuidanceFocus();
    const timer = window.setTimeout(() => cardRef.current?.focus(), reduced ? 0 : 120);
    return () => window.clearTimeout(timer);
  }, [state.open, reduced]);

  // Resolve the approved target. No target means a centered instruction; a missing target becomes a
  // readable fallback instead of an endless wait or a broken overlay.
  React.useEffect(() => {
    // Reset after paint so switching steps never triggers a synchronous cascading render.
    const resetTimer = window.setTimeout(() => {
      setHit(null);
      setMissing(false);
      setWaiting(true);
      setPlacement(null);
    }, 0);
    if (!state.open || !tutorial || !step) return () => window.clearTimeout(resetTimer);
    if (!step.targetId) {
      setTargetState("found");
      return () => window.clearTimeout(resetTimer);
    }
    if (routeMismatch) {
      setTargetState("idle");
      return () => window.clearTimeout(resetTimer);
    }
    setTargetState("searching");
    const cleanup = subscribeToTarget({
      id: step.targetId,
      timeoutMs: 8000,
      onHit: (next) => {
        setHit(next);
        setWaiting(false);
        setMissing(false);
        setTargetState("found");
        if (next.element) scrollTargetIntoView(next.element, Boolean(reduced));
      },
      onMissing: () => {
        setWaiting(false);
        setMissing(true);
        setTargetState("missing");
        void reportTargetMissing();
      },
    });
    return () => {
      window.clearTimeout(resetTimer);
      cleanup();
    };
    // The step is identified by stable primitives; depending on the step object would re-subscribe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, tutorial?.slug, step?.targetId, step?.key, routeMismatch, retryKey, reduced]);

  // Keep the tooltip beside the real element as the page scrolls, resizes or its content changes.
  React.useLayoutEffect(() => {
    if (!hit || routeMismatch) {
      const clearTimer = window.setTimeout(() => setPlacement(null), 0);
      return () => window.clearTimeout(clearTimer);
    }
    const recompute = () => {
      const card = cardRef.current;
      const width = card?.offsetWidth ?? CARD_WIDTH;
      const height = card?.offsetHeight ?? 200;
      const live = findVisibleTarget(step?.targetId ?? "")?.rect ?? hit.rect;
      setPlacement(placeTooltip(live, width, height, window.innerWidth, window.innerHeight));
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener("resize", recompute);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [hit, step?.targetId, state.stepIndex, state.phase, routeMismatch, missing, waiting, mobile]);

  // Click-to-advance uses the real control; it never prevents the button's own behaviour.
  React.useEffect(() => {
    if (!state.open || effectivePhase !== "active" || !hit || step?.advance !== "click") return;
    const element = hit.element;
    const onClick = () => {
      if (advancingRef.current) return;
      advancingRef.current = true;
      // Advance immediately: a delayed timer can be cancelled when the control navigates. The
      // control's own click behaviour is never prevented.
      void tutorialActions.next();
      window.setTimeout(() => {
        advancingRef.current = false;
      }, 600);
    };
    element.addEventListener("click", onClick, true);
    return () => element.removeEventListener("click", onClick, true);
  }, [state.open, effectivePhase, hit, step?.advance]);

  // A completion check is requested only after the real destination appears. The server decides
  // whether this is navigation, a finished walkthrough or a confirmed business action.
  React.useEffect(() => {
    if (!state.open || !tutorial || effectivePhase !== "active") return;
    if (tutorial.completion.kind === "finish") return;
    const isLast = state.stepIndex >= tutorial.steps.length - 1;
    if (!isLast) return;
    const matcher = compileCompletionPattern(tutorial.completion.pattern);
    if (!matcher || !matcher.test(cleanPath)) return;
    const key = `${tutorial.slug}:${state.progress?.tutorialVersion}:${state.progress?.startedAt}`;
    if (completedRef.current === key) return;
    completedRef.current = key;
    void confirmTutorialCompletion(cleanPath);
  }, [state.open, tutorial, effectivePhase, state.stepIndex, cleanPath, state.progress?.tutorialVersion, state.progress?.startedAt]);

  React.useEffect(() => {
    if (!state.open || !tutorial || effectivePhase !== "active") return;
    const key = `${tutorial.slug}:${state.progress?.tutorialVersion}:${state.progress?.startedAt}:${state.stepIndex}`;
    if (viewedRef.current === key) return;
    viewedRef.current = key;
    void tutorialActions.viewed(state.stepIndex);
  }, [state.open, tutorial, effectivePhase, state.stepIndex, state.progress?.tutorialVersion, state.progress?.startedAt]);

  React.useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (effectivePhase === "active" || effectivePhase === "paused") pauseAndClose();
      else closeTutorial();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, effectivePhase]);

  if (!state.open || !tutorial || !step) return null;

  const stepNumber = Math.min(state.stepIndex, tutorial.steps.length - 1) + 1;
  const total = tutorial.steps.length;
  const isLast = stepNumber >= total;
  const routeLabel = step.route ? routeLabelFor(step.route) : null;
  const canSkip = Boolean(step.optional);
  const busy = state.busy;
  const active = effectivePhase === "active";
  const dim = Boolean(hit && !hit.insideDialog);
  const cardStyle = mobile
    ? undefined
    : placement
      ? { left: placement.left, top: placement.top, width: placement.width }
      : hit
        ? { left: 24, top: 24, width: CARD_WIDTH, opacity: 0 }
        : undefined;

  const announce =
    effectivePhase === "completed"
      ? state.verified
        ? `Action verified. ${state.message ?? "Confirmed by the workspace."}`
        : `Walkthrough finished. ${state.message ?? "No business action was confirmed."}`
      : effectivePhase === "confirming"
        ? "Checking the workspace for completion."
        : effectivePhase === "exited"
          ? "Walkthrough ended."
          : effectivePhase === "paused"
            ? `Walkthrough paused at step ${stepNumber} of ${total}.`
            : `Step ${stepNumber} of ${total}: ${step.title}. ${step.body}`;

  return (
    <AnimatePresence>
      <div className="pointer-events-none fixed inset-0 z-[74]">
        {dim && (
          <motion.div
            className="pointer-events-none absolute inset-0 bg-[#050814]/55"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            aria-hidden
          />
        )}
        {hit && (
          <motion.div
            data-aqi-highlight
            className="pointer-events-none absolute z-[75] rounded-2xl ring-2 ring-primary"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              left: hit.rect.left - 6,
              top: hit.rect.top - 6,
              width: hit.rect.width + 12,
              height: hit.rect.height + 12,
              boxShadow: dim ? undefined : "0 0 0 3px rgba(44,91,255,.22), 0 10px 40px -12px rgba(44,91,255,.55)",
            }}
            aria-hidden
          >
            {active && step.advance === "click" && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-on shadow-soft motion-safe:animate-pulse">1</span>
            )}
          </motion.div>
        )}

        <motion.div
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby="aqi-tutorial-title"
          aria-describedby="aqi-tutorial-body"
          data-aqi-path={cleanPath}
          data-aqi-step={state.stepIndex}
          tabIndex={-1}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className={cn(
            "pointer-events-auto absolute z-[76] flex max-h-[min(72dvh,420px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-float outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            mobile ? "inset-x-3 bottom-3 max-h-[52dvh] rounded-2xl pb-[max(0px,env(safe-area-inset-bottom))]" : "",
          )}
          style={cardStyle}
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line bg-gradient-to-br from-primary-soft/70 via-surface to-surface px-4 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-ink">
                <Sparkles className="size-3" aria-hidden />
                {tutorial.category}
                <span className="text-faint" aria-hidden>·</span>
                <span>{tutorial.title}</span>
                {state.preview && <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning-ink">Preview</span>}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[11px] font-semibold tabular-nums text-ink-2">Step {stepNumber} of {total}</span>
                <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <span className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(stepNumber / total) * 100}%` }} />
                </span>
                {state.verified && effectivePhase === "completed" && <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success-ink"><ShieldCheck className="size-2.5" /> verified</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {active && <button type="button" onClick={() => void tutorialActions.pause()} disabled={busy} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-aqi-control="pause" aria-label="Pause walkthrough"><Pause className="size-3.5" /></button>}
              <button type="button" onClick={() => (active || effectivePhase === "paused" ? pauseAndClose() : closeTutorial())} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-aqi-control="close" aria-label="Close walkthrough"><X className="size-4" /></button>
            </div>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {effectivePhase === "completed" ? (
              <CompletionCard verified={state.verified} title={tutorial.title} message={state.message} />
            ) : effectivePhase === "exited" ? (
              <div role="status" className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><CircleHelp className="size-4 text-warning" /> Walkthrough ended</p>
                <p className="text-[13px] leading-relaxed text-muted">{state.message ?? "Nothing was marked complete. You can restart the walkthrough whenever you like."}</p>
              </div>
            ) : effectivePhase === "paused" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Pause className="size-4 text-primary" /> Paused at step {stepNumber}</p>
                <p className="text-[13px] leading-relaxed text-muted">Your progress is saved. You can come back from the AQi launcher, or resume now.</p>
              </div>
            ) : effectivePhase === "confirming" ? (
              <div role="status" className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Loader2 className="size-4 animate-spin text-primary" /> Checking the workspace</p>
                <p className="text-[13px] leading-relaxed text-muted">AQi is confirming what actually happened. It will only say the action was completed when the workspace confirms it.</p>
              </div>
            ) : effectivePhase === "unavailable" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><CircleHelp className="size-4 text-warning" /> This walkthrough was updated</p>
                <p className="text-[13px] leading-relaxed text-muted">{state.message ?? "The published version changed while you were working. Restart to continue safely; your earlier progress is preserved."}</p>
              </div>
            ) : effectivePhase === "error" ? (
              <div role="alert" className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><CircleHelp className="size-4 text-danger" /> Something interrupted the walkthrough</p>
                <p className="text-[13px] leading-relaxed text-muted">{state.error ?? "That step could not be saved. Your progress is kept; please try again."}</p>
              </div>
            ) : routeMismatch ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><ExternalLink className="size-4 text-primary" /> Let&apos;s open {routeLabel ?? "that page"} first</p>
                <p className="text-[13px] leading-relaxed text-muted">This step happens on another page. AQi will wait for the real page and then continue from step {stepNumber}; it will not restart the walkthrough.</p>
              </div>
            ) : (
              <>
                <h2 id="aqi-tutorial-title" className="text-[15px] font-semibold tracking-tight text-ink">{step.title}</h2>
                <p id="aqi-tutorial-body" className="mt-1.5 text-[13px] leading-relaxed text-muted">{step.body}</p>
                {waiting && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-2" role="status">
                    <Loader2 className="size-3 animate-spin text-primary" aria-hidden /> Looking for this control…
                  </p>
                )}
                {missing && (
                  <div role="status" className="mt-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning-ink">
                    I couldn&apos;t find that control on this page. It may have moved or been renamed. You can retry, skip {canSkip ? "" : "only when this step is optional"} or exit without losing your progress.
                  </div>
                )}
                {state.message && (
                  <div role="status" className="mt-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
                    {state.message}
                  </div>
                )}
                {step.advance === "click" && !missing && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary-soft px-2 py-1 text-[11px] font-medium text-primary-ink">
                    <ArrowRight className="size-3" aria-hidden /> Select the highlighted control to continue — or use Next.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2.5">
            <div className="flex items-center gap-1">
              {(active || effectivePhase === "paused" || effectivePhase === "confirming") && (
                <Button type="button" size="sm" variant="ghost" data-aqi-control="exit" onClick={() => void tutorialActions.exit()} disabled={busy} className="text-muted"><X className="size-3.5" /> Exit</Button>
              )}
              {active && !isLast && canSkip && !missing && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void tutorialActions.skip()} disabled={busy}><SkipForward className="size-3.5" /> Skip</Button>
              )}
              {active && missing && canSkip && <Button type="button" size="sm" variant="ghost" onClick={() => void tutorialActions.skip()} disabled={busy}><SkipForward className="size-3.5" /> Skip step</Button>}
              {active && missing && <Button type="button" size="sm" variant="ghost" onClick={() => setRetryKey((value) => value + 1)}><RotateCcw className="size-3.5" /> Retry</Button>}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {routeMismatch && active && (
                <Button type="button" size="sm" variant="brand" onClick={() => (step.route ? router.push(step.route) : undefined)}>
                  Open {routeLabel ?? "page"} <ArrowRight className="size-3.5" />
                </Button>
              )}
              {!routeMismatch && active && (
                <>
                  <Button type="button" size="sm" variant="secondary" data-aqi-control="back" onClick={() => void tutorialActions.previous()} disabled={busy || state.stepIndex === 0}><ArrowLeft className="size-3.5" /> Back</Button>
                  {isLast && tutorial.completion.kind !== "finish" ? (
                    <Button type="button" size="sm" variant="brand" onClick={() => void tutorialActions.complete()} loading={busy} aria-label="Check completion">
                      Check completion <ShieldCheck className="size-3.5" />
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="brand" onClick={() => void tutorialActions.next()} loading={busy} disabled={waiting || missing} data-aqi-control="next" aria-label={isLast ? "Finish walkthrough" : "Next step"}>
                      {isLast ? "Finish" : "Next"} <ArrowRight className="size-3.5" />
                    </Button>
                  )}
                </>
              )}
              {effectivePhase === "paused" && (
                <Button type="button" size="sm" variant="brand" onClick={() => void tutorialActions.resume()} loading={busy}><Play className="size-3.5" /> Resume</Button>
              )}
              {(effectivePhase === "completed" || effectivePhase === "exited" || effectivePhase === "unavailable") && (
                <>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void tutorialActions.restart()} loading={busy}><RotateCcw className="size-3.5" /> {effectivePhase === "completed" ? "Replay" : "Restart"}</Button>
                  <Button type="button" size="sm" variant="brand" onClick={closeTutorial}>Done</Button>
                </>
              )}
              {effectivePhase === "confirming" && (
                <Button type="button" size="sm" variant="secondary" onClick={() => void tutorialActions.complete()} loading={busy}><RotateCcw className="size-3.5" /> Check again</Button>
              )}
              {effectivePhase === "error" && (
                <>
                  <Button type="button" size="sm" variant="secondary" onClick={retryTutorialAction} disabled={busy}><RotateCcw className="size-3.5" /> Try again</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={closeTutorial}>Close</Button>
                </>
              )}
            </div>
          </div>
          <p className="sr-only" role="status" aria-live="polite">{announce}</p>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

function CompletionCard({ verified, title, message }: { verified: boolean; title: string; message: string | null }) {
  return (
    <div className="space-y-2" role="status">
      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide", verified ? "bg-success-soft text-success-ink" : "bg-primary-soft text-primary-ink")}>
        <Check className="size-3" /> {verified ? "Verified" : "Finished"}
      </span>
      <p className="text-[15px] font-semibold tracking-tight text-ink">{verified ? "Action verified" : "Walkthrough finished"}</p>
      <p className="text-[13px] leading-relaxed text-muted">
        {message ?? (verified ? `The workspace confirmed the action for “${title}”.` : `You reached the end of “${title}”. No business action was submitted or confirmed.`)}
      </p>
    </div>
  );
}

function routeLabelFor(path: string): string {
  const labels: Record<string, string> = {
    "/overview": "Overview",
    "/workforce": "AI Workforce",
    "/crm/contacts": "Contacts",
    "/crm/pipelines": "Pipelines",
    "/crm/calendar": "Calendar",
    "/appointments": "Appointments",
    "/leads": "Leads",
    "/settings": "Settings",
    "/settings/team": "Team",
    "/settings/integrations": "Integrations",
    "/support": "Support",
    "/knowledge": "Knowledge Center",
    "/admin": "Agency dashboard",
    "/admin/clients": "Clients",
    "/admin/aqi": "AQi Management",
    "/admin/aqi/insights": "AQi Insights",
  };
  return labels[path] ?? "that page";
}
