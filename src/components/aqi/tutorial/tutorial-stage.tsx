"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, CircleHelp, ExternalLink, Loader2, Pause, Play, RotateCcw, ShieldCheck, SkipForward, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { matchAqiRoute } from "@/lib/aqi/routes";
import { aqiNavTarget } from "@/lib/aqi/targets";
import { compileCompletionPattern } from "@/lib/aqi/tutorials";
import { cn } from "@/lib/utils";
import {
  closeTutorial,
  confirmTutorialCompletion,
  markGuidance,
  pauseAndClose,
  rememberGuidanceFocus,
  reportTargetMissing,
  retryTutorialAction,
  setStageReady,
  setTargetState,
  tutorialActions,
  useGuidance,
} from "@/components/aqi/tutorial/tutorial-store";
import { measureTopInset, normalizePath, routeMatches, scrollTargetIntoView, subscribeToTarget, type TargetHit } from "@/components/aqi/tutorial/target-observer";
import { placeCard, type Box, type CardPlacement } from "@/components/aqi/tutorial/placement";

const CARD_WIDTH = 344;
/** How long a target may take to appear before the card stops waiting and shows a looking-for status. */
const SEARCH_GRACE_MS = 280;
const SETTLE_MS = 160;
const PHONE_QUERY = "(max-width: 639px)";

interface Metrics {
  vw: number;
  vh: number;
  cardHeight: number;
  topInset: number;
  launcher: Box | null;
  phone: boolean;
}

interface Layout {
  left: number;
  top: number;
  width: number;
  side: CardPlacement["side"] | "sheet";
  arrow: CardPlacement["arrow"];
}

interface Found {
  key: string;
  hit: TargetHit;
}

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function sameMetrics(a: Metrics | null, b: Metrics): boolean {
  return Boolean(a) && a!.vw === b.vw && a!.vh === b.vh && a!.cardHeight === b.cardHeight && a!.topInset === b.topInset && a!.phone === b.phone
    && a!.launcher?.left === b.launcher?.left && a!.launcher?.top === b.launcher?.top;
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  return Boolean(a) && a!.left === b.left && a!.top === b.top && a!.width === b.width && a!.side === b.side && a!.arrow?.offset === b.arrow?.offset;
}

function layoutFor(metrics: Metrics, spot: TargetHit | null): Layout {
  if (metrics.phone) return { left: 0, top: 0, width: metrics.vw - 24, side: "sheet", arrow: null };
  const placement = placeCard({
    target: spot ? toBox(spot.rect) : null,
    card: { width: CARD_WIDTH, height: metrics.cardHeight },
    viewport: { width: metrics.vw, height: metrics.vh },
    topInset: metrics.topInset,
    avoid: metrics.launcher ? [metrics.launcher] : [],
  });
  return { left: Math.round(placement.left), top: Math.round(placement.top), width: Math.round(placement.width), side: placement.side, arrow: placement.arrow };
}

/**
 * The walkthrough card and spotlight.
 *
 * The card is positioned from measurements, never from a default: it stays hidden until it has a
 * real position, so it can neither appear in a corner nor jump there first. With a visible target it
 * sits beside it (right, below, left, above, whichever has room); with a step on another page it
 * highlights the real navigation item when there is one and otherwise docks beside the AQi launcher;
 * on a phone it is a bottom sheet and the page is scrolled so the target stays visible above it.
 */
export function TutorialStage() {
  const state = useGuidance();
  const pathname = usePathname();
  const router = useRouter();
  const reduced = Boolean(useReducedMotion());
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [found, setFound] = React.useState<Found | null>(null);
  const [navFound, setNavFound] = React.useState<Found | null>(null);
  const [settledKey, setSettledKey] = React.useState<string | null>(null);
  const [missingKey, setMissingKey] = React.useState<string | null>(null);
  const [slowKey, setSlowKey] = React.useState<string | null>(null);
  const [retryKey, setRetryKey] = React.useState(0);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [shown, setShown] = React.useState<Layout | null>(null);
  const [movingFor, setMovingFor] = React.useState<string | null>(null);
  const completedRef = React.useRef<string | null>(null);
  const viewedRef = React.useRef<string | null>(null);
  const advancingRef = React.useRef(false);
  const metricsRef = React.useRef<Metrics | null>(null);

  const tutorial = state.tutorial;
  const step = tutorial?.steps[Math.min(state.stepIndex, Math.max(0, (tutorial?.steps.length ?? 1) - 1))] ?? null;
  const cleanPath = normalizePath(pathname);
  const routeMismatch = Boolean(step?.route && !routeMatches(step.route, cleanPath));
  const phase = state.phase;
  const active = phase === "active";
  const stepKey = tutorial && step ? `${tutorial.slug}:${tutorial.version}:${step.key}:${retryKey}` : "";
  const wantsTarget = active && Boolean(step?.targetId) && !routeMismatch;
  const foundForStep = wantsTarget && found?.key === stepKey ? found.hit : null;
  const hit = foundForStep && settledKey === stepKey ? foundForStep : null;
  const navHit = active && routeMismatch && navFound?.key === stepKey ? navFound.hit : null;
  const spot = hit ?? navHit;
  const missing = wantsTarget && missingKey === stepKey;
  const waiting = wantsTarget && !foundForStep && !missing;
  const slow = waiting && slowKey === stepKey;
  // The card is placed once there is something real to place it by: a settled target, a docked
  // state, or a search that has outlasted its grace period. Until then it keeps its last position.
  const shouldPlace = Boolean(metrics) && (!wantsTarget || Boolean(hit) || missing || slow);

  const computed = React.useMemo(
    () => (metrics && shouldPlace ? layoutFor(metrics, spot) : null),
    // spot.rect is replaced whenever the target moves, so it is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metrics, shouldPlace, spot?.rect.left, spot?.rect.top, spot?.rect.width, spot?.rect.height, spot?.element],
  );
  // Derived state: adopt the new layout during render so it is never painted one frame late.
  if (computed && !sameLayout(shown, computed)) setShown(computed);
  const [lastStepKey, setLastStepKey] = React.useState(stepKey);
  if (lastStepKey !== stepKey) {
    setLastStepKey(stepKey);
    if (shown) setMovingFor(stepKey);
  }
  const moving = movingFor === stepKey && !reduced;

  // Tell the "starting" card it can hand over once this card is placed and visible.
  const isShown = Boolean(shown);
  React.useEffect(() => {
    if (isShown) markGuidance("stage:shown");
    setStageReady(isShown);
    return () => setStageReady(false);
  }, [isShown]);

  React.useEffect(() => {
    if (!movingFor) return;
    const timer = window.setTimeout(() => setMovingFor(null), 420);
    return () => window.clearTimeout(timer);
  }, [movingFor]);

  // Track the viewport, the card's own size, a pinned header and the launcher without polling.
  const measure = React.useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const phone = window.matchMedia(PHONE_QUERY).matches;
    const launcherRect = document.querySelector<HTMLElement>("[data-aqi-launcher]")?.getBoundingClientRect() ?? null;
    const next: Metrics = {
      vw: window.innerWidth,
      vh: window.innerHeight,
      cardHeight: Math.round(card.offsetHeight),
      topInset: measureTopInset(),
      launcher: launcherRect && launcherRect.width > 0 ? { left: Math.round(launcherRect.left), top: Math.round(launcherRect.top), width: Math.round(launcherRect.width), height: Math.round(launcherRect.height) } : null,
      phone,
    };
    if (sameMetrics(metricsRef.current, next)) return;
    metricsRef.current = next;
    setMetrics(next);
  }, []);

  React.useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [measure, tutorial?.slug]);

  // The card's height changes with its content; re-measure after every step or phase change.
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [measure, stepKey, phase, routeMismatch, missing, waiting]);

  React.useEffect(() => {
    markGuidance("stage:mounted");
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

  // Resolve the approved target for this step. A step on another page waits for its route first.
  React.useEffect(() => {
    if (!state.open || !tutorial || !step || !active) return;
    if (!step.targetId) {
      setTargetState("found");
      return;
    }
    if (routeMismatch) {
      setTargetState("idle");
      return;
    }
    const key = stepKey;
    setTargetState("searching");
    // On a phone the sidebar is hidden behind the menu button. A navigation step can only
    // highlight the real link once the drawer is open, so ask the shell to open it as the step
    // starts (not after the 8 s missing-target timeout, when the observer has already given up).
    if ((step.targetId ?? "").startsWith("nav.") && window.matchMedia("(max-width: 1023px)").matches) {
      window.dispatchEvent(new CustomEvent("iaq:open-mobile-nav"));
    }
    const slowTimer = window.setTimeout(() => setSlowKey(key), SEARCH_GRACE_MS);
    let settleTimer = 0;
    const markSettled = () => setSettledKey(key);
    const cleanup = subscribeToTarget({
      id: step.targetId,
      timeoutMs: 8000,
      onHit: (next, info) => {
        // A control that shows up after the search gave up (a slow page, a dialog opened later) clears
        // the "couldn't find it" notice and re-enables Next without needing Retry.
        setMissingKey(null);
        setFound({ key, hit: next });
        setTargetState("found");
        if (info.first) {
          markGuidance("stage:hit");
          window.clearTimeout(slowTimer);
          const sheet = window.matchMedia(PHONE_QUERY).matches;
          const scrolled = scrollTargetIntoView(next.element, reduced, {
            topInset: measureTopInset(),
            bottomInset: sheet ? (cardRef.current?.offsetHeight ?? 260) + 12 : 24,
          });
          // Reveal the spotlight only once the page has stopped scrolling, never while it slides.
          settleTimer = window.setTimeout(markSettled, scrolled ? SETTLE_MS : 0);
        } else if (settleTimer) {
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(markSettled, SETTLE_MS);
        }
      },
      onLost: () => {
        window.clearTimeout(settleTimer);
        setFound(null);
        setSettledKey(null);
        setTargetState("searching");
      },
      onMissing: () => {
        setMissingKey(key);
        setTargetState("missing");
        void reportTargetMissing();
      },
    });
    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(settleTimer);
      cleanup();
      setFound(null);
      setSettledKey(null);
      setSlowKey(null);
      setMissingKey(null);
    };
    // The step is identified by stable primitives; depending on the step object would re-subscribe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, active, tutorial?.slug, step?.targetId, step?.key, routeMismatch, stepKey, reduced]);

  // A step on another page highlights the real navigation item for that page when one is on screen.
  React.useEffect(() => {
    if (!state.open || !active || !routeMismatch || !step?.route) return;
    const id = aqiNavTarget(step.route, cleanPath.startsWith("/admin") ? "agency" : "client");
    if (!id) return;
    const key = stepKey;
    return subscribeToTarget({
      id,
      timeoutMs: 0,
      onHit: (next) => setNavFound({ key, hit: next }),
      onLost: () => setNavFound(null),
    });
  }, [state.open, active, routeMismatch, step?.route, stepKey, cleanPath]);

  // Click-to-advance uses the real control; it never prevents the button's own behaviour.
  React.useEffect(() => {
    if (!state.open || !active || !hit || step?.advance !== "click") return;
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
  }, [state.open, active, hit, step?.advance]);

  // A completion check is requested only after the real destination appears. The server decides
  // whether this is navigation, a finished walkthrough or a confirmed business action.
  React.useEffect(() => {
    if (!state.open || !tutorial || !active) return;
    if (tutorial.completion.kind === "finish") return;
    const isLast = state.stepIndex >= tutorial.steps.length - 1;
    if (!isLast) return;
    const matcher = compileCompletionPattern(tutorial.completion.pattern);
    if (!matcher || !matcher.test(cleanPath)) return;
    const key = `${tutorial.slug}:${state.progress?.tutorialVersion}:${state.progress?.startedAt}`;
    if (completedRef.current === key) return;
    completedRef.current = key;
    void confirmTutorialCompletion(cleanPath);
  }, [state.open, tutorial, active, state.stepIndex, cleanPath, state.progress?.tutorialVersion, state.progress?.startedAt]);

  React.useEffect(() => {
    if (!state.open || !tutorial || !active) return;
    const key = `${tutorial.slug}:${state.progress?.tutorialVersion}:${state.progress?.startedAt}:${state.stepIndex}`;
    if (viewedRef.current === key) return;
    viewedRef.current = key;
    void tutorialActions.viewed(state.stepIndex);
  }, [state.open, tutorial, active, state.stepIndex, state.progress?.tutorialVersion, state.progress?.startedAt]);

  React.useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (phase === "active" || phase === "paused") pauseAndClose();
      else closeTutorial();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.open, phase]);

  if (!state.open || !tutorial || !step) return null;

  const stepNumber = Math.min(state.stepIndex, tutorial.steps.length - 1) + 1;
  const total = tutorial.steps.length;
  const isLast = stepNumber >= total;
  const routeLabel = step.route ? routeLabelFor(step.route) : null;
  const canSkip = Boolean(step.optional);
  const busy = state.busy;
  const sheet = shown?.side === "sheet";
  const dim = Boolean(spot && !spot.insideDialog);
  const showingStep = active && !routeMismatch;
  const titleId = showingStep ? "aqi-tutorial-title" : "aqi-tutorial-status";

  const announce =
    phase === "completed"
      ? state.verified
        ? `Action verified. ${state.message ?? "Confirmed by the workspace."}`
        : `Walkthrough finished. ${state.message ?? "No business action was confirmed."}`
      : phase === "confirming"
        ? "Checking the workspace for completion."
        : phase === "exited"
          ? "Walkthrough ended."
          : phase === "paused"
            ? `Walkthrough paused at step ${stepNumber} of ${total}.`
            : routeMismatch
              ? `Step ${stepNumber} of ${total}: open ${routeLabel ?? "the next page"} to continue.`
              : `Step ${stepNumber} of ${total}: ${step.title}. ${step.body}`;

  const cardStyle: React.CSSProperties = sheet
    ? { bottom: "max(12px, env(safe-area-inset-bottom))" }
    : shown
      ? { width: shown.width, transform: `translate3d(${shown.left}px, ${shown.top}px, 0)` }
      : { width: Math.min(CARD_WIDTH, typeof window === "undefined" ? CARD_WIDTH : window.innerWidth - 24) };

  return (
    <div data-aqi-stage className="pointer-events-none fixed inset-0 z-[74]">
      {spot && (
        <div
          data-aqi-highlight
          aria-hidden
          className="pointer-events-none absolute z-[75]"
          style={{
            // Positioned with a transform so following a scroll or a resize is not reported as layout shift.
            left: 0,
            top: 0,
            transform: `translate3d(${spot.rect.left - 6}px, ${spot.rect.top - 6}px, 0)`,
            width: spot.rect.width + 12,
            height: spot.rect.height + 12,
            borderRadius: Math.min(18, spot.radius + 6),
            // The spread shadow dims everything except the target, so the control itself stays bright.
            boxShadow: dim ? "0 0 0 2px var(--primary), 0 0 0 6px rgba(44, 91, 255, 0.24), 0 0 0 9999px rgba(5, 8, 20, 0.55)" : "0 0 0 2px var(--primary), 0 0 0 6px rgba(44, 91, 255, 0.24), 0 10px 40px -12px rgba(44, 91, 255, 0.55)",
            transition: moving ? "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), width 220ms, height 220ms, border-radius 220ms" : undefined,
          }}
        >
          {active && step.advance === "click" && hit && (
            <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-primary-on shadow-soft motion-safe:animate-pulse">1</span>
          )}
        </div>
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby="aqi-tutorial-body"
        data-aqi-card
        data-aqi-placement={shown?.side ?? "pending"}
        data-aqi-revealed={shown ? "true" : "false"}
        data-aqi-moving={moving ? "true" : "false"}
        data-aqi-path={cleanPath}
        data-aqi-step={state.stepIndex}
        tabIndex={-1}
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") setMovingFor(null);
        }}
        className={cn(
          "aqi-card pointer-events-auto fixed z-[76] flex max-h-[min(72dvh,460px)] flex-col rounded-2xl border border-line bg-surface text-ink shadow-float outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          sheet ? "inset-x-3 max-h-[46dvh]" : "left-0 top-0",
        )}
        style={{ ...cardStyle, visibility: shown ? "visible" : "hidden" }}
      >
        {shown?.arrow && !sheet && (
          <span
            aria-hidden
            className={cn(
              "absolute size-2.5 rotate-45 bg-surface",
              shown.arrow.edge === "left" && "-left-[6px] border-b border-l border-line",
              shown.arrow.edge === "right" && "-right-[6px] border-r border-t border-line",
              shown.arrow.edge === "top" && "-top-[6px] border-l border-t border-line",
              shown.arrow.edge === "bottom" && "-bottom-[6px] border-b border-r border-line",
            )}
            style={shown.arrow.edge === "left" || shown.arrow.edge === "right" ? { top: shown.arrow.offset - 5 } : { left: shown.arrow.offset - 5 }}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
          <div className="flex shrink-0 items-center gap-2 px-3.5 pb-1 pt-3">
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
            <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary-ink">{tutorial.title}</p>
            {state.preview && <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-warning-ink">Preview</span>}
            {active && (
              <button type="button" onClick={() => void tutorialActions.pause()} disabled={busy} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50" data-aqi-control="pause" aria-label="Pause walkthrough"><Pause className="size-3.5" /></button>
            )}
            <button type="button" onClick={() => (active || phase === "paused" ? pauseAndClose() : closeTutorial())} className="-mr-1 flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" data-aqi-control="close" aria-label="Close walkthrough"><X className="size-4" /></button>
          </div>
          <div className="flex shrink-0 items-center gap-2 px-3.5 pb-2">
            <span className="text-[12px] font-semibold tabular-nums text-ink-2">Step {stepNumber} of {total}</span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(stepNumber / total) * 100}%` }} />
            </span>
            {state.verified && phase === "completed" && <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-success-ink"><ShieldCheck className="size-2.5" /> verified</span>}
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
            <StageBody
              phase={phase}
              routeMismatch={routeMismatch}
              routeLabel={routeLabel}
              stepNumber={stepNumber}
              step={step}
              state={state}
              tutorialTitle={tutorial.title}
              waiting={slow}
              missing={missing}
              canSkip={canSkip}
              titleId={titleId}
              hasNavHighlight={Boolean(navHit)}
            />
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2.5">
            <div className="flex items-center gap-1">
              {(active || phase === "paused" || phase === "confirming") && (
                <Button type="button" size="sm" variant="ghost" data-aqi-control="exit" onClick={() => void tutorialActions.exit()} disabled={busy} className="text-muted"><X className="size-3.5" /> Exit</Button>
              )}
              {active && !isLast && canSkip && !missing && !routeMismatch && (
                <Button type="button" size="sm" variant="ghost" onClick={() => void tutorialActions.skip()} disabled={busy}><SkipForward className="size-3.5" /> Skip</Button>
              )}
              {active && missing && <Button type="button" size="sm" variant="ghost" onClick={() => void tutorialActions.skip()} disabled={busy}><SkipForward className="size-3.5" /> Skip step</Button>}
              {active && missing && <Button type="button" size="sm" variant="ghost" onClick={() => setRetryKey((value) => value + 1)}><RotateCcw className="size-3.5" /> Retry</Button>}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {routeMismatch && active && (
                <Button type="button" size="sm" variant="brand" data-aqi-control="open-page" onClick={() => (step.route ? router.push(step.route) : undefined)}>
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
              {phase === "paused" && (
                <Button type="button" size="sm" variant="brand" onClick={() => void tutorialActions.resume()} loading={busy}><Play className="size-3.5" /> Resume</Button>
              )}
              {(phase === "completed" || phase === "exited" || phase === "unavailable") && (
                <>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void tutorialActions.restart()} loading={busy}><RotateCcw className="size-3.5" /> {phase === "completed" ? "Replay" : "Restart"}</Button>
                  <Button type="button" size="sm" variant="brand" onClick={closeTutorial}>Done</Button>
                </>
              )}
              {phase === "confirming" && (
                <Button type="button" size="sm" variant="secondary" onClick={() => void tutorialActions.complete()} loading={busy}><RotateCcw className="size-3.5" /> Check again</Button>
              )}
              {phase === "error" && (
                <>
                  <Button type="button" size="sm" variant="secondary" onClick={retryTutorialAction} disabled={busy}><RotateCcw className="size-3.5" /> Try again</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={closeTutorial}>Close</Button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </div>
  );
}

interface StageBodyProps {
  phase: ReturnType<typeof useGuidance>["phase"];
  routeMismatch: boolean;
  routeLabel: string | null;
  stepNumber: number;
  step: NonNullable<ReturnType<typeof useGuidance>["tutorial"]>["steps"][number];
  state: ReturnType<typeof useGuidance>;
  tutorialTitle: string;
  waiting: boolean;
  missing: boolean;
  canSkip: boolean;
  titleId: string;
  hasNavHighlight: boolean;
}

function StageBody({ phase, routeMismatch, routeLabel, stepNumber, step, state, tutorialTitle, waiting, missing, canSkip, titleId, hasNavHighlight }: StageBodyProps) {
  const heading = "text-[15px] font-semibold leading-snug tracking-tight text-ink";
  const copy = "mt-1 text-[13px] leading-relaxed text-muted";
  if (phase === "completed") return <CompletionCard verified={state.verified} title={tutorialTitle} message={state.message} titleId={titleId} />;
  if (phase === "exited") {
    return (
      <div role="status">
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><CircleHelp className="size-4 shrink-0 text-warning" aria-hidden /> Walkthrough ended</h2>
        <p id="aqi-tutorial-body" className={copy}>{state.message ?? "Nothing was marked complete. You can restart the walkthrough whenever you like."}</p>
      </div>
    );
  }
  if (phase === "paused") {
    return (
      <div>
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><Pause className="size-4 shrink-0 text-primary" aria-hidden /> Paused at step {stepNumber}</h2>
        <p id="aqi-tutorial-body" className={copy}>Your progress is saved. Resume now, or come back from the AQi launcher.</p>
      </div>
    );
  }
  if (phase === "confirming") {
    return (
      <div role="status">
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden /> Checking the workspace</h2>
        <p id="aqi-tutorial-body" className={copy}>AQi only says the action was completed when the workspace confirms it.</p>
      </div>
    );
  }
  if (phase === "unavailable") {
    return (
      <div>
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><CircleHelp className="size-4 shrink-0 text-warning" aria-hidden /> This walkthrough was updated</h2>
        <p id="aqi-tutorial-body" className={copy}>{state.message ?? "The published version changed while you were working. Restart to continue safely; your earlier progress is kept."}</p>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div role="alert">
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><CircleHelp className="size-4 shrink-0 text-danger" aria-hidden /> That didn&apos;t save</h2>
        <p id="aqi-tutorial-body" className={copy}>{state.error ?? "Your place is kept. Please try again."}</p>
      </div>
    );
  }
  if (routeMismatch) {
    return (
      <div>
        <h2 id={titleId} className={cn(heading, "flex items-center gap-2")}><ExternalLink className="size-4 shrink-0 text-primary" aria-hidden /> Let&apos;s open {routeLabel ?? "the next page"}</h2>
        <p id="aqi-tutorial-body" className={copy}>
          {hasNavHighlight ? `Select ${routeLabel ?? "it"} in the highlighted menu, or use the button. ` : ""}We&apos;ll pick up at step {stepNumber} on the {routeLabel ?? "next"} page.
        </p>
      </div>
    );
  }
  return (
    <>
      <h2 id={titleId} className={heading}>{step.title}</h2>
      <p id="aqi-tutorial-body" className={copy}>{step.body}</p>
      {waiting && !missing && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-[12px] font-medium text-ink-2" role="status">
          <Loader2 className="size-3 animate-spin text-primary" aria-hidden /> Looking for this control…
        </p>
      )}
      {missing && (
        <div role="status" className="mt-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-warning-ink">
          I couldn&apos;t find that control on this page. It may have moved, or the page is still loading. Try again{canSkip ? ", skip this step" : ""} or exit; your place is kept.
        </div>
      )}
      {state.message && (
        <div role="status" className="mt-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
          {state.message}
        </div>
      )}
      {step.advance === "click" && !missing && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary-soft px-2 py-1 text-[12px] font-medium text-primary-ink">
          <ArrowRight className="size-3" aria-hidden /> Select the highlighted control, or use Next.
        </p>
      )}
    </>
  );
}

function CompletionCard({ verified, title, message, titleId }: { verified: boolean; title: string; message: string | null; titleId: string }) {
  return (
    <div role="status">
      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-semibold uppercase tracking-wide", verified ? "bg-success-soft text-success-ink" : "bg-primary-soft text-primary-ink")}>
        <Check className="size-3" aria-hidden /> {verified ? "Verified" : "Finished"}
      </span>
      <h2 id={titleId} className="mt-1.5 text-[15px] font-semibold tracking-tight text-ink">{verified ? "Action verified" : "Walkthrough finished"}</h2>
      <p id="aqi-tutorial-body" className="mt-1 text-[13px] leading-relaxed text-muted">
        {message ?? (verified ? `The workspace confirmed the action for “${title}”.` : `You reached the end of “${title}”. No business action was submitted or confirmed.`)}
      </p>
    </div>
  );
}

const ROUTE_LABELS: Record<string, string> = {
  "/overview": "Overview",
  "/employees": "AI Employees",
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

function routeLabelFor(path: string): string {
  return ROUTE_LABELS[path] ?? matchAqiRoute(path)?.label ?? "that page";
}
