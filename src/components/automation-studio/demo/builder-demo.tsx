"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Eye, FlaskConical, History, Loader2, Lock, MessageSquare, Pause, Play, RotateCcw, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoCanvas } from "@/components/automation-studio/demo/canvas";
import { BEATS, CHAPTER_START, CHAPTERS, DEMO_MESSAGES, freshBetween, LAST, NEXT_STEPS, phoneDelay, viewOf, type Beat, type DemoView } from "@/components/automation-studio/demo/script";
import "@/components/automation-studio/demo/demo.css";

// The upgrade page's example, played back: a request in plain English, the builder's reply, the steps drawn one by one, a change asked for in
// the chat, and what would come next. It is a fixed script (demo/script.ts). Watching it calls nothing, saves nothing and sends nothing; the only
// things running are the timer of the next beat while it plays, and an observer that pauses it when it's scrolled out of view.
//
// On a phone or a tablet the whole example fits one screen, so nothing has to be scrolled to while it plays. A phone shows the chat and the
// canvas in turns, in one space, as the real editor does there: the example switches to whichever the current beat is about, and the person can
// switch themselves. From a tablet up they sit side by side.

const NEXT_ICONS = { test: FlaskConical, publish: ShieldCheck, refine: History } as const;
/** The real canvas's colour families (stepTone): what starts it, messages, records and tasks, timing, and logic. */
const LEGEND = [
  { label: "Trigger", swatch: "brand-gradient" },
  { label: "Message", swatch: "bg-primary" },
  { label: "Task", swatch: "bg-success" },
  { label: "Wait", swatch: "bg-violet" },
  { label: "Condition", swatch: "bg-muted" },
];
const VIEWS = [
  { view: "chat", label: "Chat", Icon: MessageSquare },
  { view: "canvas", label: "Canvas", Icon: Workflow },
] as const;
/** Below this width (Tailwind's @2xl) the chat and the canvas take turns, so a reply needs reading time before the canvas takes over. */
const SIDE_BY_SIDE_FROM = 672;

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
  /** On a phone, the view the person chose, and the beat they chose it at. It holds until the example moves on to the other view by itself. */
  manual: { view: DemoView; at: number } | null;
  /** What a screen reader hears after a control moved the example. Playing on its own says nothing. */
  announce: string;
}

type Action =
  | { type: "seen"; autoplay: boolean }
  | { type: "unseen" }
  | { type: "tick" }
  | { type: "toggle"; shown: number }
  /** One beat back or forward (holds it still), or a chapter (plays from there unless it's held, or motion is reduced). */
  | { type: "go"; to: number; shown: number; step: boolean; reduced: boolean }
  | { type: "view"; view: DemoView; shown: number };

/** A choice of view lasts while the example stays on the same view; once it moves on to the other one by itself, it follows the example again. */
const keepManual = (manual: State["manual"], from: number, to: number) => (manual && viewOf(BEATS[from]) === viewOf(BEATS[to]) ? manual : null);

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case "seen":
      if (!s.started) return a.autoplay ? { ...s, started: true, playing: true, held: false, beat: 0, from: 0, manual: null } : s;
      return s.offscreen ? { ...s, offscreen: false, playing: true } : s;
    case "unseen":
      return s.playing ? { ...s, playing: false, offscreen: true } : s;
    case "tick": {
      if (s.beat >= LAST) return { ...s, playing: false };
      const beat = s.beat + 1;
      return { ...s, beat, from: s.beat, playing: beat < LAST, manual: keepManual(s.manual, s.beat, beat), announce: "" };
    }
    case "toggle":
      if (s.playing) return { ...s, started: true, playing: false, held: true, offscreen: false, announce: "Paused." };
      if (a.shown >= LAST) return { ...s, started: true, playing: true, held: false, offscreen: false, beat: 0, from: 0, manual: null, announce: "Playing the example from the start." };
      return { ...s, started: true, playing: true, held: false, offscreen: false, beat: a.shown, from: a.shown, manual: null, announce: "" };
    case "go": {
      const to = Math.max(0, Math.min(LAST, a.to));
      const held = a.step || s.held;
      const playing = to < LAST && !a.step && (s.playing || (!held && !a.reduced));
      return { ...s, started: true, beat: to, from: a.shown, offscreen: false, held, playing, manual: keepManual(s.manual, a.shown, to), announce: BEATS[to].caption };
    }
    case "view":
      return { ...s, manual: a.view === viewOf(BEATS[a.shown]) ? null : { view: a.view, at: a.shown } };
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
const canvasKey = (b: Beat) => `${b.stage}|${b.nodes.join()}|${b.edges.join()}`;

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
  const scroller = React.useRef<HTMLDivElement>(null);
  const swipe = React.useRef<{ x: number; y: number; t: number } | null>(null);
  const [inTurns, setInTurns] = React.useState(false);
  const [chatScrolls, setChatScrolls] = React.useState(false);
  const [state, dispatch] = React.useReducer(reduce, { beat: 0, from: 0, playing: false, started: false, offscreen: false, held: false, manual: null, announce: "" });

  const shown = state.started || canAutoplay ? state.beat : LAST;
  const from = state.started ? state.from : shown;
  const beat = BEATS[shown];
  const done = shown >= LAST;
  const running = state.playing && !done;
  const fresh = React.useMemo(() => (shown === from + 1 ? freshBetween(BEATS[from], BEATS[shown]) : NO_CHANGE), [shown, from]);
  const view = state.manual?.view ?? viewOf(beat);
  // What changed in the view that isn't showing since the person chose the other one: marked with a dot on its switch.
  const since = state.manual ? BEATS[state.manual.at] : beat;
  const unseen: Record<DemoView, boolean> = {
    chat: since.messages !== beat.messages || since.status !== beat.status || Boolean(since.next) !== Boolean(beat.next),
    canvas: canvasKey(since) !== canvasKey(beat),
  };

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

  // Whether the chat and the canvas are taking turns (a phone): only the pace depends on it; the layout itself is the stylesheet's.
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setInTurns(e.contentRect.width > 0 && e.contentRect.width < SIDE_BY_SIDE_FROM));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => dispatch({ type: "tick" }), inTurns ? phoneDelay(shown + 1) : BEATS[shown + 1].after);
    return () => window.clearTimeout(t);
  }, [running, shown, inTurns]);

  // Whether the conversation scrolls (a phone or a tablet, once it's long): then it can take keyboard focus, so it can be scrolled without a pointer.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setChatScrolls(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, []);

  // The conversation keeps its newest message in view where it scrolls (a phone or a tablet); beside a desktop canvas it never needs to.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1) return;
    el.scrollTo?.({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [beat.messages, beat.status, beat.next, view, reduced]);

  const label = running ? "Pause" : done ? "Replay" : shown === 0 ? "Play" : "Resume";
  const ToggleIcon = running ? Pause : done ? RotateCcw : Play;
  const go = (to: number, step: boolean) => dispatch({ type: "go", to, shown, step, reduced });

  // A sideways swipe across the example steps it, like the arrows; an up-and-down one is left to the page.
  const onPointerDown = (e: React.PointerEvent) => {
    swipe.current = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || e.pointerType !== "touch") return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5 || e.timeStamp - s.t > 800) return;
    const to = shown + (dx < 0 ? 1 : -1);
    if (to >= 0 && to <= LAST) go(to, true);
  };

  return (
    <div ref={root} className="@container overflow-hidden rounded-[28px] border border-line bg-surface shadow-lg">
      {/* Below a desktop width the example is exactly one screen high, under the portal's header. */}
      <div className="flex h-[clamp(540px,calc(100svh-88px),780px)] flex-col @4xl:h-auto">
        {/* What this is, said before anything plays. */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 @2xl:px-5 @2xl:py-3">
          <span aria-hidden className="hidden size-8 shrink-0 items-center justify-center rounded-xl brand-gradient text-white @2xl:inline-flex"><Sparkles className="size-4" /></span>
          <div className="hidden min-w-0 @2xl:block">
            <p className="text-[13.5px] font-semibold leading-tight text-ink">AI Automation Builder</p>
            <p className="truncate text-[12px] leading-tight text-muted">Welcome new leads · example draft</p>
          </div>
          <p className="text-[12px] font-medium leading-snug text-ink-2 @2xl:ml-auto @2xl:rounded-full @2xl:border @2xl:border-line @2xl:bg-surface-2 @2xl:px-3 @2xl:py-1">
            <Eye className="mr-1.5 inline size-3.5 align-[-2px] text-muted" aria-hidden />Interactive example <span aria-hidden className="text-faint">·</span> Nothing is saved or sent
          </p>
        </div>

        {/* The stage: on a phone the chat and the canvas share it (one shows at a time); from a tablet up they sit side by side. */}
        <div
          className="grid min-h-0 flex-1 touch-pan-y touch-pinch-zoom grid-rows-[minmax(0,1fr)] *:[grid-area:1/1] @2xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)] @2xl:*:[grid-area:auto] @4xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] @4xl:grid-rows-[auto] @6xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { swipe.current = null; }}
        >
          {/* The conversation. Where it scrolls, it sits at the bottom by the message box and keeps the newest message in view, like a chat. */}
          <div data-panel="chat" data-off={view !== "chat" ? "" : undefined} className="demo-panel relative flex min-h-0 min-w-0 flex-col bg-surface @2xl:border-r @2xl:border-line">
            <div
              ref={scroller}
              tabIndex={chatScrolls ? 0 : undefined}
              role={chatScrolls ? "region" : undefined}
              aria-label={chatScrolls ? "Example conversation, scrollable" : undefined}
              className="demo-chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto touch-pan-y touch-pinch-zoom focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary @4xl:overflow-visible"
            >
              {/* On a phone the header is shortened to the label, so the conversation names what it's building, as a chat app dates a thread. */}
              <p className="mx-auto mt-5 rounded-full bg-surface-2 px-3 py-1 text-[12px] font-medium text-muted @2xl:hidden">Welcome new leads · example draft</p>
              <ul aria-label="Example conversation" className="mt-auto flex flex-col gap-4 p-4 sm:p-5 @4xl:mt-0 @4xl:flex-1">
                {[0, 1].map((x) => {
                  const pair = [x * 2, x * 2 + 1];
                  const working = (i: number) => DEMO_MESSAGES[i].from !== "you" && i === beat.messages && Boolean(beat.status);
                  const any = pair.some((i) => i < beat.messages || working(i));
                  return (
                    // Beside a desktop canvas, messages still to come keep their space, so nothing shifts; where the chat scrolls, they aren't there yet.
                    <li key={x} className={cn("flex flex-col gap-3", !any && "@max-4xl:hidden")}>
                      {pair.map((i) => {
                        const m = DEMO_MESSAGES[i];
                        const on = i < beat.messages;
                        const mine = m.from === "you";
                        return (
                          <div key={i} className={cn("relative flex", mine ? "justify-end" : "justify-start", !on && !working(i) && "@max-4xl:hidden")}>
                            <div data-message={i} data-shown={on ? "true" : "false"} aria-hidden={!on} className={cn("max-w-[90%]", on ? "demo-rise" : "invisible @max-4xl:hidden")}>
                              {!mine && (
                                <span aria-hidden className="mb-1.5 flex items-center gap-1.5 pl-1 text-[12px] font-semibold text-ink-2 @2xl:hidden">
                                  <span className="inline-flex size-4 items-center justify-center rounded-md brand-gradient text-white"><Sparkles className="size-2.5" /></span>AI Automation Builder
                                </span>
                              )}
                              <p className={cn("text-pretty rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-normal", mine ? "rounded-br-md bg-primary text-primary-on" : "rounded-bl-md border border-line bg-surface-2 text-ink")}>
                                <span className="sr-only">{mine ? "You: " : "Builder: "}</span>{m.text}
                              </p>
                              {!mine && <p className="mt-1 pl-1 text-[12px] font-medium text-success-ink">Updated the canvas</p>}
                            </div>
                            {working(i) && (
                              <p role="status" className="demo-rise absolute left-0 top-0 inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-muted @max-4xl:static">
                                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />{beat.status}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </li>
                  );
                })}
                <li className={cn("@4xl:mt-auto", !beat.next && "@max-4xl:hidden")}>
                  <div data-next={beat.next ? "shown" : "hidden"} aria-hidden={!beat.next} className={cn("rounded-2xl border border-line bg-surface p-3.5 shadow-soft", beat.next ? "demo-rise" : "invisible")}>
                    <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-ink">What happens next <span className="font-medium normal-case tracking-normal text-muted">· in your workspace</span></p>
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
            </div>
            <p aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-[38%] px-6 text-center text-[13px] text-faint transition-opacity duration-300", beat.messages || beat.status ? "opacity-0" : "opacity-100")}>
              The conversation appears here
            </p>
            <div aria-hidden className="mx-4 mb-4 flex shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-faint sm:mx-5 sm:mb-5">
              <Lock className="size-3.5 shrink-0" /><span className="min-w-0 truncate">Ask for a change…</span><span className="ml-auto shrink-0 text-[12px]">Needs the plan</span>
            </div>
          </div>

          <div data-panel="canvas" data-off={view !== "canvas" ? "" : undefined} className="demo-panel flex min-h-0 min-w-0 flex-col">
            <div className="hidden flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5 sm:px-5 @4xl:flex">
              <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-muted">Example</span>
              <span className="text-[12px] text-muted">Draft · not published</span>
              <ul aria-label="What the colours mean" className="ml-auto flex items-center gap-3">
                {LEGEND.map((l) => (
                  <li key={l.label} className="inline-flex items-center gap-1.5 text-[12px] text-muted"><span aria-hidden className={cn("size-2 rounded-full", l.swatch)} />{l.label}</li>
                ))}
              </ul>
            </div>
            <DemoCanvas beat={beat} fresh={fresh} className="min-h-0 flex-1 touch-pan-y touch-pinch-zoom @4xl:min-h-[640px]" />
          </div>
        </div>

        {/* What this beat shows (right under the stage on a phone, under the controls from a tablet up), then the controls: play or pause, one
            beat back or forward, on a phone which half shows, and the four chapters to jump between. */}
        <div className="flex shrink-0 flex-col border-t border-line">
          <p data-caption className="order-first min-h-[calc(2lh+0.625rem)] text-pretty px-4 pt-2.5 text-center text-[13px] leading-snug text-ink-2 @2xl:order-last @2xl:min-h-0 @2xl:border-t @2xl:border-line @2xl:bg-surface-2/60 @2xl:px-5 @2xl:py-2.5 @2xl:text-left">
            {beat.caption}
          </p>
          <div className="flex flex-wrap items-center gap-1 px-3 pb-2.5 pt-1.5 @2xl:flex-nowrap @2xl:gap-5 @2xl:px-4 @2xl:py-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => dispatch({ type: "toggle", shown })}
                aria-label={`${label} the example`}
                className="inline-flex size-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-ink text-surface shadow-soft transition active:scale-[0.97] hover:bg-ink/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary @2xl:h-8 @2xl:w-auto @2xl:min-w-[104px] @2xl:rounded-xl @2xl:border @2xl:border-line @2xl:bg-surface @2xl:px-3 @2xl:text-[13px] @2xl:font-medium @2xl:text-ink @2xl:hover:bg-surface-2 @2xl:pointer-coarse:h-11"
              >
                <ToggleIcon className="size-4 @2xl:size-3.5" aria-hidden /><span className="hidden @2xl:inline">{label}</span>
              </button>
              {([[-1, "Previous step of the example", ChevronLeft, shown === 0], [1, "Next step of the example", ChevronRight, done]] as const).map(([by, name, Icon, off]) => (
                <button
                  key={by}
                  type="button"
                  onClick={() => go(shown + by, true)}
                  disabled={off}
                  aria-label={name}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-40 @2xl:size-8 @2xl:pointer-coarse:size-11"
                >
                  <Icon className="size-4" aria-hidden />
                </button>
              ))}
              <span className="ml-1.5 hidden text-[12px] tabular-nums text-muted @2xl:inline">{shown === 0 ? "Ready" : `${shown} of ${LAST}`}</span>
            </div>
            <div role="group" aria-label="Show" className="ml-auto inline-flex rounded-xl border border-line bg-surface-2 p-0.5 @2xl:hidden">
              {VIEWS.map(({ view: v, label: text, Icon }) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  aria-label={`Show the ${v} of the example`}
                  onClick={() => dispatch({ type: "view", view: v, shown })}
                  className="relative inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-soft"
                >
                  <Icon className="size-3.5" aria-hidden />{text}
                  {view !== v && unseen[v] && <span aria-hidden data-unseen className="absolute right-1 top-1.5 size-1.5 rounded-full bg-primary" />}
                </button>
              ))}
            </div>
            <ol aria-label="Chapters" className="mt-1 grid basis-full grid-cols-4 gap-1.5 @2xl:mt-0 @2xl:flex-1 @2xl:basis-auto">
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
                        "group flex min-h-11 w-full flex-col justify-center gap-1.5 rounded-lg px-1 text-left text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary @sm:text-[12px] @2xl:min-h-9 @2xl:px-1.5 @2xl:pointer-coarse:min-h-11",
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
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{state.announce}</p>
    </div>
  );
}
