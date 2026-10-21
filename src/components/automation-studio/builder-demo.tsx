"use client";

import * as React from "react";
import { Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StaticCanvas } from "@/components/automation-studio/canvas/static-canvas";
import { edgeId, TRIGGER_ID, type ChangeMark } from "@/components/automation-studio/canvas/flow-model";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";

// The upgrade page's example, played back: a request in plain English, the builder adding each step to the canvas, then one change asked for in
// the chat. Everything is a script in this file. Nothing is the person's data, nothing calls the builder, and nothing is saved or sent.

type Layout = "wide" | "narrow";

/** Where each step sits. Placed by hand (the step's editor-only `ui` position) so the example reads at a useful size; "narrow" fits a phone. */
const PLACES: Record<Layout, Record<string, { x: number; y: number }>> = {
  wide: { welcome: { x: 0, y: 140 }, wait: { x: 0, y: 280 }, check: { x: 0, y: 420 }, done: { x: -170, y: 580 }, nudge: { x: 170, y: 580 } },
  narrow: { welcome: { x: 0, y: 140 }, wait: { x: 0, y: 280 }, check: { x: 0, y: 420 }, done: { x: -76, y: 580 }, nudge: { x: 40, y: 740 } },
};

export function exampleDefinition(layout: Layout, waitDays: 2 | 3): WorkflowDefinition {
  const at = PLACES[layout];
  return {
    trigger: { type: "contact.created" },
    steps: [
      { key: "welcome", kind: "create_task", name: "Welcome the lead", config: { title: "Welcome call", priority: "high", assignee: "contact_owner" }, next: "wait", ui: at.welcome },
      { key: "wait", kind: "wait", name: `Wait ${waitDays} days`, config: { mode: "duration", amount: waitDays, unit: "days" }, next: "check", ui: at.wait },
      { key: "check", kind: "branch", name: "Did they reply?", config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "replied" }, next: null, branches: { yes: "done", no: "nudge" }, ui: at.check },
      { key: "done", kind: "end", name: "Nothing more to do", config: {}, next: null, ui: at.done },
      { key: "nudge", kind: "notify_team", name: "Remind the team", config: { roles: ["owner", "admin"], title: "No reply yet: give them a call" }, next: null, ui: at.nudge },
    ] as unknown as WorkflowStep[],
  };
}

export const DEMO_MESSAGES = [
  { from: "you", text: "When a new lead comes in, welcome them, and if they haven’t replied after two days, remind my team." },
  { from: "ai", text: "Done. Each new lead gets a welcome task. If they haven’t replied two days later, your team is reminded to call. Nothing runs until you publish it." },
  { from: "you", text: "Actually, make that three days." },
  { from: "ai", text: "Updated. The wait is now three days, and everything else stays the same." },
] as const;

interface Beat {
  /** How long after the previous beat this one lands, in ms. */
  after: number;
  /** Messages shown (a count from the start of DEMO_MESSAGES). */
  messages: number;
  /** The builder is working on the next reply: what it says it is doing. */
  working?: string;
  /** Nodes drawn so far. */
  nodes: string[];
  waitDays: 2 | 3;
  /** The phase the "How it works" steps call it. */
  phase: 0 | 1 | 2 | 3;
}

const ALL = [TRIGGER_ID, "welcome", "wait", "check", "done", "nudge"];
export const BEATS: Beat[] = [
  { after: 0, messages: 0, nodes: [], waitDays: 2, phase: 0 },
  { after: 350, messages: 1, nodes: [], waitDays: 2, phase: 1 },
  { after: 700, messages: 1, working: "Reading your request", nodes: [], waitDays: 2, phase: 2 },
  { after: 750, messages: 1, working: "Adding the trigger", nodes: ALL.slice(0, 1), waitDays: 2, phase: 2 },
  { after: 650, messages: 1, working: "Adding “Welcome the lead”", nodes: ALL.slice(0, 2), waitDays: 2, phase: 2 },
  { after: 650, messages: 1, working: "Adding “Wait 2 days”", nodes: ALL.slice(0, 3), waitDays: 2, phase: 2 },
  { after: 650, messages: 1, working: "Adding “Did they reply?”", nodes: ALL.slice(0, 4), waitDays: 2, phase: 2 },
  { after: 650, messages: 1, working: "Connecting both paths", nodes: ALL, waitDays: 2, phase: 2 },
  { after: 800, messages: 2, nodes: ALL, waitDays: 2, phase: 2 },
  { after: 1900, messages: 3, nodes: ALL, waitDays: 2, phase: 3 },
  { after: 700, messages: 3, working: "Changing “Wait 2 days”", nodes: ALL, waitDays: 2, phase: 3 },
  { after: 900, messages: 4, nodes: ALL, waitDays: 3, phase: 3 },
];
const LAST = BEATS.length - 1;

const PHASES = ["Describe", "Build", "Refine"] as const;

/** What changed between two beats, for the canvas's change motion: nodes that just appeared, the step that was just edited, and the new lines. */
function changes(prev: Beat | undefined, beat: Beat, def: WorkflowDefinition) {
  const marks = new Map<string, ChangeMark>();
  const before = new Set(prev?.nodes ?? []);
  for (const k of beat.nodes) if (!before.has(k)) marks.set(k, "added");
  if (beat.waitDays === 3) marks.set("wait", "modified");
  const edges = new Set<string>();
  const first = def.steps?.[0];
  if (first && marks.get(first.key) === "added") edges.add(edgeId(TRIGGER_ID, "next", first.key));
  for (const s of def.steps ?? []) {
    if (s.next && marks.get(s.next) === "added") edges.add(edgeId(s.key, "next", s.next));
    if (s.branches?.yes && marks.get(s.branches.yes) === "added") edges.add(edgeId(s.key, "yes", s.branches.yes));
    if (s.branches?.no && marks.get(s.branches.no) === "added") edges.add(edgeId(s.key, "no", s.branches.no));
  }
  return { marks, edges };
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

/**
 * The example conversation and the canvas it builds. It starts once it scrolls into view (never for people who ask for reduced motion, who see the
 * finished example), can be paused, and plays once; Replay starts it over. On the server, before the page is interactive, and without
 * IntersectionObserver, the finished example is what's shown.
 */
export function BuilderDemo() {
  const reduced = React.useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => false);
  const hydrated = React.useSyncExternalStore(noSubscribe, () => true, () => false);
  const canAutoplay = hydrated && !reduced && typeof IntersectionObserver !== "undefined";
  const root = React.useRef<HTMLDivElement>(null);
  const [step, setStep] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const startedRef = React.useRef(false);
  const [layout, setLayout] = React.useState<Layout>("wide");

  // Until it has been started (by scrolling to it, or by the button), the example waits empty where it will play, or shows its end where it won't.
  const beat = started || canAutoplay ? step : LAST;
  const done = beat >= LAST;
  const running = playing && !done;

  const start = React.useCallback(() => {
    startedRef.current = true;
    setStarted(true);
  }, []);

  // The layout follows the demo's own width, not the window's.
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setLayout(e.contentRect.width < 560 ? "narrow" : "wide"));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Plays the first time at least a third of it is on screen.
  React.useEffect(() => {
    const el = root.current;
    if (!el || !canAutoplay || startedRef.current) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || startedRef.current) return;
      start();
      setPlaying(true);
      io.disconnect();
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [canAutoplay, start]);

  React.useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setStep((b) => Math.min(b + 1, LAST)), BEATS[beat + 1].after);
    return () => window.clearTimeout(t);
  }, [running, beat]);

  const control = () => {
    start();
    if (running) return setPlaying(false);
    if (done) setStep(0);
    setPlaying(true);
  };

  const current = BEATS[beat];
  const definition = React.useMemo(() => exampleDefinition(layout, current.waitDays), [layout, current.waitDays]);
  const visible = React.useMemo(() => new Set(current.nodes), [current.nodes]);
  const { marks, edges } = React.useMemo(() => changes(BEATS[beat - 1], current, definition), [beat, current, definition]);
  const controlLabel = running ? "Pause" : done ? "Replay" : beat === 0 ? "Play" : "Resume";
  const ControlIcon = running ? Pause : done ? RotateCcw : Play;

  return (
    <div ref={root} className="@container overflow-hidden rounded-3xl border border-line bg-surface shadow-md">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <ol className="flex flex-wrap items-center gap-1.5" aria-label="What the example shows">
          {PHASES.map((p, i) => {
            const state = current.phase > i + 1 || (done && i === 2) ? "done" : current.phase === i + 1 ? "now" : "next";
            return (
              <li key={p} aria-current={state === "now" ? "step" : undefined} className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-300",
                state === "now" ? "bg-primary-soft text-primary-ink" : state === "done" ? "text-ink-2" : "text-faint",
              )}>
                <span className={cn("inline-flex size-[18px] items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums transition-colors duration-300", state === "next" ? "border border-line-strong" : "bg-primary text-primary-on")}>{i + 1}</span>
                {p}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid @4xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)] @6xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="flex flex-col border-b border-line @4xl:border-b-0 @4xl:border-r">
          <div className="flex items-center gap-2.5 px-4 pb-1 pt-4 sm:px-5">
            <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-xl brand-gradient text-white"><Sparkles className="size-4" /></span>
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold leading-tight text-ink">AI Automation Builder</p>
              <p className="text-[12px] leading-tight text-muted">Example conversation</p>
            </div>
            <Button variant="secondary" size="sm" className="ml-auto" onClick={control} aria-label={`${controlLabel} the example`}>
              <ControlIcon className="size-3.5" aria-hidden />{controlLabel}
            </Button>
          </div>
          {/* Every message keeps its space from the start, so nothing on the page shifts while the example plays. */}
          <ul className="flex flex-1 flex-col gap-3 px-4 py-4 sm:px-5" aria-label="Example conversation">
            {DEMO_MESSAGES.map((m, i) => {
              const shown = i < current.messages;
              const working = !shown && i === current.messages && current.working;
              return (
                <li key={i} className={cn("relative flex", m.from === "you" ? "justify-end" : "justify-start")}>
                  <p
                    aria-hidden={!shown}
                    className={cn(
                      "max-w-[88%] text-pretty rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed",
                      m.from === "you" ? "rounded-br-md bg-primary text-primary-on" : "rounded-bl-md border border-line bg-surface-2 text-ink",
                      shown ? "page-in" : "invisible",
                    )}
                  >
                    {m.text}
                  </p>
                  {working && (
                    <span role="status" className="page-in absolute left-0 top-0 inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-muted">
                      <span aria-hidden className="inline-flex gap-0.5"><span className="thinking-dot size-1.5 rounded-full bg-primary" /><span className="thinking-dot size-1.5 rounded-full bg-primary" /><span className="thinking-dot size-1.5 rounded-full bg-primary" /></span>
                      {current.working}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-4 py-3 text-[12px] leading-snug text-muted sm:px-5">An illustration with sample steps. Nothing here is your data, and nothing is saved or sent.</p>
        </div>
        <div className={cn("relative", layout !== "narrow" && "p-3 sm:p-4")}>
          <p aria-hidden className={cn("pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-[13px] text-faint transition-opacity duration-300", current.nodes.length ? "opacity-0" : "opacity-100")}>
            The automation appears here as it’s built
          </p>
          <StaticCanvas
            definition={definition}
            visible={visible}
            marks={marks}
            addedEdges={edges}
            className={layout === "narrow" ? "aspect-[20/43] h-auto rounded-none border-0" : "h-[540px] rounded-xl @4xl:h-[600px]"}
            fitPadding={layout === "narrow" ? 0.04 : 0.08}
            label="An example automation: a welcome task, a wait, a check for a reply, and a reminder to the team"
          />
        </div>
      </div>
    </div>
  );
}
