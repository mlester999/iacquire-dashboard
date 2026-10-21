"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Eye, FlaskConical, History, Loader2, Lock, Pause, Play, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DemoCanvas } from "@/components/automation-studio/demo/canvas";
import { BEATS, CHAPTER_START, CHAPTERS, DEMO_MESSAGES, freshBetween, LAST, NEXT_STEPS } from "@/components/automation-studio/demo/script";
import "@/components/automation-studio/demo/demo.css";

// The upgrade page's example, played back: a request in plain English, the builder's reply, the steps drawn one by one, a change asked for in
// the chat, and what would come next. It is a fixed script (demo/script.ts). Watching it calls nothing, saves nothing and sends nothing; the only
// things running are the timer of the next beat while it plays, and an observer that pauses it when it's scrolled out of view.

const NEXT_ICONS = { test: FlaskConical, publish: ShieldCheck, refine: History } as const;
/** The real canvas's colour families (stepTone): what starts it, messages, records and tasks, timing, and logic. */
const LEGEND = [
  { label: "Trigger", swatch: "brand-gradient" },
  { label: "Message", swatch: "bg-primary" },
  { label: "Task", swatch: "bg-success" },
  { label: "Wait", swatch: "bg-violet" },
  { label: "Condition", swatch: "bg-muted" },
];

interface State {
  beat: number;
  /** The beat it came from: only a step forward by one plays the entrance of what's new. */
  from: number;
  playing: boolean;
  /** Started, by scrolling to it or by a control. Until then it shows its start (or, where it won't play by itself, its end). */
  started: boolean;
  /** Paused because it left the screen (or the tab was hidden), not by the person: it resumes when it's back. */
  offscreen: boolean;
  /** The person paused it or is stepping through it: choosing a chapter then doesn't start it playing. */
  held: boolean;
  /** What a screen reader hears after a control moved the example. Playing on its own says nothing. */
  announce: string;
}

type Action =
  | { type: "seen"; autoplay: boolean }
  | { type: "unseen" }
  | { type: "tick" }
  | { type: "toggle"; shown: number }
  /** One beat back or forward (holds it still), or a chapter (plays from there unless it's held, or motion is reduced). */
  | { type: "go"; to: number; shown: number; step: boolean; reduced: boolean };

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "seen":
      if (!s.started) return a.autoplay ? { ...s, started: true, playing: true, held: false, beat: 0, from: 0 } : s;
      return s.offscreen ? { ...s, offscreen: false, playing: true } : s;
    case "unseen":
      return s.playing ? { ...s, playing: false, offscreen: true } : s;
    case "tick": {
      if (s.beat >= LAST) return { ...s, playing: false };
      const beat = s.beat + 1;
      return { ...s, beat, from: s.beat, playing: beat < LAST, announce: "" };
    }
    case "toggle":
      if (s.playing) return { ...s, started: true, playing: false, held: true, offscreen: false, announce: "Paused." };
      if (a.shown >= LAST) return { ...s, started: true, playing: true, held: false, offscreen: false, beat: 0, from: 0, announce: "Playing the example from the start." };
      return { ...s, started: true, playing: true, held: false, offscreen: false, beat: a.shown, from: a.shown, announce: "" };
    case "go": {
      const to = Math.max(0, Math.min(LAST, a.to));
      const held = a.step || s.held;
      const playing = to < LAST && !a.step && (s.playing || (!held && !a.reduced));
      return { ...s, started: true, beat: to, from: a.shown, offscreen: false, held, playing, announce: BEATS[to].caption };
    }
  }
}

const REDUCED = "(prefers-reduced-motion: reduce)";
const noSubscribe = () => () => {};
function subscribeReduced(on: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const q = window.matchMedia(REDUCED);
  q.addEventListener?.("change", on);
  return () => q.removeEventListener?.("change", on);
}
const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches;
const NO_CHANGE = { nodes: new Set<string>(), edges: new Set<string>() };

/** Which part of the conversation a phone shows: the first exchange, the second, or the closing card. */
function currentPart(messages: number, next: boolean) {
  return next ? 2 : messages > 2 ? 1 : 0;
}

/**
 * The example conversation, the canvas it builds and its controls. It starts once it scrolls into view (never by itself for people who ask
 * for reduced motion: they see the finished example and can play or step through it), pauses when it leaves the screen, and plays once.
 * On the server, and before the page is interactive, the finished example is what's shown.
 */
export function BuilderDemo() {
  const reduced = React.useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => false);
  const hydrated = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  const canObserve = hydrated && typeof IntersectionObserver !== "undefined";
  const canAutoplay = canObserve && !reduced;
  const root = React.useRef<HTMLDivElement>(null);
  const [state, dispatch] = React.useReducer(reduce, { beat: 0, from: 0, playing: false, started: false, offscreen: false, held: false, announce: "" });

  const shown = state.started || canAutoplay ? state.beat : LAST;
  const from = state.started ? state.from : shown;
  const beat = BEATS[shown];
  const done = shown >= LAST;
  const running = state.playing && !done;
  const fresh = React.useMemo(() => (shown === from + 1 ? freshBetween(BEATS[from], BEATS[shown]) : NO_CHANGE), [shown, from]);

  // Starts the first time a third of it is on screen; pauses when it's (nearly) gone, and picks up again when it's back.
  React.useEffect(() => {
    const el = root.current;
    if (!el || !canObserve) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio >= 0.35) dispatch({ type: "seen", autoplay: canAutoplay });
      else if (!e.isIntersecting || e.intersectionRatio < 0.08) dispatch({ type: "unseen" });
    }, { threshold: [0, 0.08, 0.35] });
    io.observe(el);
    const onVisibility = () => {
      if (document.hidden) return dispatch({ type: "unseen" });
      const r = el.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (r.height > 0 && visible / r.height >= 0.35) dispatch({ type: "seen", autoplay: canAutoplay });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canObserve, canAutoplay]);

  React.useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => dispatch({ type: "tick" }), BEATS[shown + 1].after);
    return () => window.clearTimeout(t);
  }, [running, shown]);

  const label = running ? "Pause" : done ? "Replay" : shown === 0 ? "Play" : "Resume";
  const ToggleIcon = running ? Pause : done ? RotateCcw : Play;
  const part = currentPart(beat.messages, Boolean(beat.next));
  const go = (to: number, step: boolean) => dispatch({ type: "go", to, shown, step, reduced });

  return (
    <div ref={root} className="@container overflow-hidden rounded-[28px] border border-line bg-surface shadow-lg">
      {/* What this is, said before anything plays. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl brand-gradient text-white"><Sparkles className="size-4" /></span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold leading-tight text-ink">AI Automation Builder</p>
          <p className="truncate text-[12px] leading-tight text-muted">Welcome new leads · example draft</p>
        </div>
        <p className="w-full rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-[12px] font-medium leading-snug text-ink-2 @lg:ml-auto @lg:w-auto @lg:rounded-full @lg:py-1">
          <Eye className="mr-1.5 inline size-3.5 align-[-2px] text-muted" aria-hidden />Interactive example <span aria-hidden className="text-faint">·</span> Nothing is saved or sent
        </p>
      </div>

      <div className="grid @4xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* The conversation. On a phone only the current exchange shows (they share one space, so the page never shifts); beside the canvas, all of it. */}
        <div className="flex flex-col border-b border-line @4xl:border-b-0 @4xl:border-r">
          <ul aria-label="Example conversation" className="grid flex-1 content-center p-4 *:[grid-area:1/1] *:self-center sm:p-5 @4xl:flex @4xl:flex-col @4xl:content-start @4xl:gap-4">
            {[0, 1].map((x) => (
              <li key={x} data-past={part !== x ? "true" : undefined} className="flex flex-col gap-3 data-[past=true]:invisible @4xl:data-[past=true]:visible">
                {[x * 2, x * 2 + 1].map((i) => {
                  const m = DEMO_MESSAGES[i];
                  const on = i < beat.messages;
                  const mine = m.from === "you";
                  const working = !on && !mine && i === beat.messages && beat.status;
                  return (
                    <div key={i} className={cn("relative flex", mine ? "justify-end" : "justify-start")}>
                      <div data-message={i} data-shown={on ? "true" : "false"} aria-hidden={!on} className={cn("max-w-[90%]", on ? "demo-rise" : "invisible")}>
                        <p className={cn("text-pretty rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-normal", mine ? "rounded-br-md bg-primary text-primary-on" : "rounded-bl-md border border-line bg-surface-2 text-ink")}>
                          <span className="sr-only">{mine ? "You: " : "Builder: "}</span>{m.text}
                        </p>
                        {!mine && <p className="mt-1 pl-1 text-[11.5px] font-medium text-success-ink">Updated the canvas</p>}
                      </div>
                      {working && (
                        <p role="status" className="demo-rise absolute left-0 top-0 inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-muted">
                          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />{beat.status}
                        </p>
                      )}
                    </div>
                  );
                })}
              </li>
            ))}
            <li data-past={part !== 2 ? "true" : undefined} className="data-[past=true]:invisible @4xl:mt-auto @4xl:data-[past=true]:visible">
              <div data-next={beat.next ? "shown" : "hidden"} aria-hidden={!beat.next} className={cn("rounded-2xl border border-line bg-surface p-3.5 shadow-soft", beat.next ? "demo-rise" : "invisible")}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary-ink">What happens next <span className="font-medium normal-case tracking-normal text-muted">· in your workspace</span></p>
                <ol className="mt-3 space-y-2">
                  {NEXT_STEPS.map((s) => {
                    const Icon = NEXT_ICONS[s.key];
                    return (
                      <li key={s.key} className="flex gap-2.5">
                        <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-ink"><Icon className="size-3.5" /></span>
                        <p className="text-[12.5px] leading-snug text-muted"><span className="font-semibold text-ink">{s.title}.</span> {s.text}</p>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </li>
          </ul>
          <div aria-hidden className="mx-4 mb-4 hidden items-center gap-2 rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-faint sm:mx-5 sm:mb-5 @4xl:flex">
            <Lock className="size-3.5 shrink-0" />Ask for a change…<span className="ml-auto text-[11.5px]">Needs the plan</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5 sm:px-5">
            <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Example</span>
            <span className="text-[12px] text-muted">Draft · not published</span>
            <ul aria-label="What the colours mean" className="ml-auto hidden items-center gap-3 @2xl:flex">
              {LEGEND.map((l) => (
                <li key={l.label} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted"><span aria-hidden className={cn("size-2 rounded-full", l.swatch)} />{l.label}</li>
              ))}
            </ul>
          </div>
          <DemoCanvas beat={beat} fresh={fresh} className="h-[560px] @lg:h-[660px] @4xl:h-auto @4xl:min-h-[640px] @4xl:flex-1" />
        </div>
      </div>

      {/* The controls: play or pause, one beat back or forward, and the four chapters to jump between. */}
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3 sm:px-4 @3xl:flex-row @3xl:items-center @3xl:gap-5">
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" className="min-w-[104px]" onClick={() => dispatch({ type: "toggle", shown })} aria-label={`${label} the example`}>
            <ToggleIcon className="size-3.5" aria-hidden />{label}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => go(shown - 1, true)} disabled={shown === 0} aria-label="Previous step of the example"><ChevronLeft className="size-4" aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => go(shown + 1, true)} disabled={done} aria-label="Next step of the example"><ChevronRight className="size-4" aria-hidden /></Button>
          <span className="ml-1.5 text-[12px] tabular-nums text-muted">{shown === 0 ? "Ready" : `${shown} of ${LAST}`}</span>
        </div>
        <ol aria-label="Chapters" className="grid flex-1 grid-cols-4 gap-1.5">
          {CHAPTERS.map((c, i) => {
            const first = CHAPTER_START[i];
            const end = i + 1 < CHAPTERS.length ? CHAPTER_START[i + 1] : LAST + 1;
            const now = beat.chapter === i;
            const fill = beat.chapter > i ? 1 : now ? (shown - first + 1) / (end - first) : 0;
            return (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => go(first, false)}
                  aria-current={now ? "step" : undefined}
                  className={cn(
                    "group flex min-h-11 w-full flex-col justify-center gap-1.5 rounded-lg px-1.5 text-left text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-9",
                    now ? "text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  <span className="truncate"><span className="sr-only">Go to chapter {i + 1}: </span>{c}</span>
                  <span aria-hidden className="block h-[3px] w-full overflow-hidden rounded-full bg-surface-3">
                    <span className="demo-progress block h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%` }} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="border-t border-line bg-surface-2/60 px-4 py-2.5 text-[13px] leading-snug text-ink-2 sm:px-5" data-caption>{beat.caption}</p>
      <p className="sr-only" aria-live="polite">{state.announce}</p>
    </div>
  );
}
