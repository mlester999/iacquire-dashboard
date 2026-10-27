"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { JOURNEY, type JourneyStep, type ViewId } from "@/lib/demo/showroom/content";
import { useShowroom } from "@/components/demo/showroom/context";

// The four-step guided journey: which steps the visitor has seen. It lives in this browser only (localStorage) and holds four yes/no facts and nothing about the visitor, so a returning
// visitor can pick up where they left off and nobody is tracked. If the browser will not store it, the journey still works for the visit (it is kept in memory). The server renders the
// first-visit state and the browser reads the stored one after it hydrates, so the two never disagree.

const KEY = "iaq-demo-journey-v1";

const listeners = new Set<() => void>();
let memory: string | null = null;

function stored(): string {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function save(visited: number[]) {
  const raw = JSON.stringify({ visited });
  memory = raw;
  try {
    window.localStorage.setItem(KEY, raw);
  } catch {
    /* storage is blocked: the journey is remembered for this visit only */
  }
  listeners.forEach((l) => l());
}

function parse(raw: string): number[] {
  try {
    const j = JSON.parse(raw) as { visited?: unknown };
    return Array.isArray(j.visited) ? [...new Set(j.visited.filter((n): n is number => n === 1 || n === 2 || n === 3 || n === 4))].sort() : [];
  } catch {
    return [];
  }
}

export interface JourneyApi {
  /** Steps seen, in this browser. Empty on the server and on the first visit. */
  visited: number[];
  /** The step the current view belongs to, if any. */
  current: JourneyStep | null;
  /** The first step not yet seen, or the first one when all have been. */
  nextStep: JourneyStep;
}

const Ctx = React.createContext<JourneyApi | null>(null);
export const useJourney = (): JourneyApi => {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useJourney must be used inside the journey provider");
  return v;
};

export function JourneyProvider({ view, children }: { view: ViewId; children: React.ReactNode }) {
  const raw = React.useSyncExternalStore(subscribe, stored, () => "");
  const visited = React.useMemo(() => parse(raw), [raw]);
  const current = JOURNEY.find((j) => j.view === view) ?? null;
  const step = current?.step;

  // Opening a step marks it seen.
  React.useEffect(() => {
    if (step && !parse(stored()).includes(step)) save([...parse(stored()), step].sort());
  }, [step]);

  const nextStep = JOURNEY.find((j) => !visited.includes(j.step)) ?? JOURNEY[0];
  const value = React.useMemo<JourneyApi>(() => ({ visited, current, nextStep }), [visited, current, nextStep]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The progress strip: four steps, each a real button that goes there; the finished ones are ticked. Anyone can skip, go back or explore freely at any moment. */
export function JourneyBar({ className }: { className?: string }) {
  const { go, view } = useShowroom();
  const { visited, current } = useJourney();
  const done = visited.length;
  return (
    <nav aria-label="Guided journey" className={cn("sx-panel-flat px-3 py-2.5", className)}>
      <div className="sx-noscrollbar relative flex items-center gap-2 overflow-x-auto">
        <p className="hidden shrink-0 pr-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted lg:block">Guided tour</p>
        <ol className="flex min-w-0 flex-1 items-center gap-1.5">
          {JOURNEY.map((j) => {
            const isCurrent = j.view === view;
            const seen = visited.includes(j.step);
            return (
              <li key={j.step} className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => go(j.view)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "group flex w-full min-w-0 items-center justify-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors sm:justify-start",
                    isCurrent ? "bg-primary-soft text-ink" : "text-ink-2 hover:bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
                      seen ? "bg-success text-[#04140b]" : isCurrent ? "bg-primary text-primary-on" : "border border-line-strong text-muted",
                    )}
                    aria-hidden
                  >
                    {seen ? <Check className="size-3.5" /> : j.step}
                  </span>
                  <span className="hidden min-w-0 truncate text-[13px] font-medium sm:inline">
                    {j.short}
                  </span>
                  <span className="sr-only">
                    Step {j.step}: {j.short}
                    {seen ? " (seen)" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="shrink-0 pl-1 text-[12px] tabular-nums text-muted" aria-label={`${done} of 4 steps seen`}>
          {done}/4
        </p>
      </div>
      <div className="sx-track mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={done} aria-label="Tour progress">
        <span style={{ width: `${(done / 4) * 100}%` }} />
      </div>
      {current && <p className="sr-only">You are on step {current.step}: {current.title}.</p>}
    </nav>
  );
}

/** Back and next, for the step the visitor is on. Both always work; neither is required. */
export function StepNav() {
  const { go, view } = useShowroom();
  const i = JOURNEY.findIndex((j) => j.view === view);
  if (i < 0) return null;
  const prev = JOURNEY[i - 1];
  const next = JOURNEY[i + 1];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
      {prev ? (
        <button type="button" onClick={() => go(prev.view)} className="sx-btn-quiet inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[14px] font-medium">
          <ArrowLeft className="size-4" aria-hidden />
          <span className="text-left">
            <span className="block text-[11px] uppercase tracking-[0.08em] text-muted">Back</span>
            {prev.short}
          </span>
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button type="button" onClick={() => go(next.view)} className="sx-btn-primary inline-flex h-12 items-center gap-3 rounded-xl px-5 text-[14px] font-semibold">
          <span className="text-left">
            <span className="block text-[11px] uppercase tracking-[0.08em] text-white/70">Next: step {next.step}</span>
            {next.title}
          </span>
          <ArrowRight className="size-4" aria-hidden />
        </button>
      ) : (
        <button type="button" onClick={() => go("pricing")} className="sx-btn-primary inline-flex h-12 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold">
          See the plans
          <ArrowRight className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
