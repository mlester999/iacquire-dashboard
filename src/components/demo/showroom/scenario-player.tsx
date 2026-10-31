"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY } from "@/lib/agents";
import type { Scenario } from "@/lib/demo/showroom/employees";
import { Chip, SimTag } from "@/components/demo/showroom/ui";

// A simulated scenario, played one step at a time. Each step is a drawing of what the work looks like: the sample board changes, the narration says who is acting and why, and nothing
// behind it exists (no search runs, no message is composed or sent, no calendar is touched, no record is saved). It plays by itself unless the visitor prefers reduced motion, can be
// paused, stepped through, and replayed, and every step is reachable by keyboard.

const subscribeMotion = (onChange: () => void) => {
  const q = window.matchMedia("(prefers-reduced-motion: reduce)");
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
};

function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
}

export function ScenarioPlayer({ scenario, onAsk, askLabel }: { scenario: Scenario; onAsk?: () => void; askLabel?: string }) {
  const total = scenario.steps.length;
  const reduced = usePrefersReducedMotion();
  const [at, setAt] = React.useState(-1);
  const [auto, setAuto] = React.useState(false);
  const started = at >= 0;
  const finished = at >= total - 1;
  const step = started ? scenario.steps[at] : null;
  // It plays until the last step; "thinking" is the wait before the next one.
  const playing = auto && !finished;

  React.useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setAt((a) => Math.min(total - 1, a + 1)), 1900);
    return () => clearTimeout(t);
  }, [playing, at, total]);

  const start = () => {
    setAt(0);
    setAuto(!reduced && total > 1);
  };
  const replay = () => {
    setAt(0);
    setAuto(!reduced && total > 1);
  };
  const step_ = (d: number) => {
    setAuto(false);
    setAt((a) => Math.max(0, Math.min(total - 1, a + d)));
  };

  return (
    <section aria-label="Simulated example" className="sx-panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-violet-soft text-violet-ink">
            <Sparkles className="size-[18px]" aria-hidden />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-ink">{scenario.board}</p>
            <p className="text-[13px] text-muted">Watch it work on a sample</p>
          </div>
        </div>
        <SimTag>Simulated: nothing is sent or saved</SimTag>
      </header>

      {!started ? (
        <div className="grid place-items-center gap-4 px-5 py-12 text-center">
          <p className="max-w-md text-[15px] leading-relaxed text-ink-2">A short, scripted example with invented people and businesses. No real search, message or booking happens.</p>
          <button type="button" onClick={start} className="sx-btn-primary inline-flex min-h-12 items-center gap-2.5 rounded-xl px-6 py-3 text-[15px] font-semibold">
            <Play className="size-4" aria-hidden />
            {scenario.prompt}
          </button>
        </div>
      ) : (
        <div className="grid @4xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4 p-5">
            <div className="flex items-start gap-3">
              {step && <AgentAvatar role={AGENT_BY_KEY[step.actor]} size="md" thinking={playing} eager />}
              <div className="min-w-0" aria-live="polite">
                <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">
                  Step {at + 1} of {total}
                  {step ? ` · ${AGENT_BY_KEY[step.actor].shortName}` : ""}
                </p>
                <p className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em] text-ink">{step?.title}</p>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{step?.narration}</p>
              </div>
            </div>
            <ul className="space-y-2" aria-label={scenario.board}>
              {step?.rows.map((r) => (
                <li key={r.label} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-semibold text-ink">{r.label}</p>
                    {r.detail && <p className="text-[13px] leading-snug text-muted">{r.detail}</p>}
                  </div>
                  {r.tag && (
                    <Chip key={r.tag} tone={r.tone ?? "neutral"} className="sx-pop shrink-0">
                      {r.tag}
                    </Chip>
                  )}
                </li>
              ))}
            </ul>
            {finished && (
              <p className="sx-fade rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[14px] leading-relaxed text-success-ink">
                That is the whole example. In your real portal, this is where you would review and approve. Here, nothing was sent, booked or saved.
              </p>
            )}
          </div>

          <aside aria-label="Steps" className="border-t border-line bg-surface-2/60 p-5 @4xl:border-l @4xl:border-t-0">
            <ol className="space-y-1">
              {scenario.steps.map((s, i) => (
                <li key={s.title}>
                  <button
                    type="button"
                    onClick={() => {
                      setAuto(false);
                      setAt(i);
                    }}
                    aria-current={i === at ? "step" : undefined}
                    className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-snug transition-colors", i === at ? "bg-primary-soft text-ink" : i < at ? "text-ink-2 hover:bg-surface-2" : "text-muted hover:bg-surface-2")}
                  >
                    <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[12px] font-semibold", i <= at ? "bg-primary text-primary-on" : "border border-line-strong text-muted")}>{i + 1}</span>
                    <span>{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => step_(-1)} disabled={at <= 0} className="sx-btn-quiet inline-flex size-10 items-center justify-center rounded-lg disabled:opacity-40" aria-label="Previous step">
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              {playing ? (
                <button type="button" onClick={() => setAuto(false)} className="sx-btn-quiet inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold">
                  <Pause className="size-4" aria-hidden />
                  Pause
                </button>
              ) : finished ? (
                <button type="button" onClick={replay} className="sx-btn-quiet inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold">
                  <RotateCcw className="size-4" aria-hidden />
                  Replay
                </button>
              ) : (
                <button type="button" onClick={() => step_(1)} className="sx-btn-primary inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold">
                  Next step
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              )}
            </div>
            {finished && onAsk && (
              <button type="button" onClick={onAsk} className="mt-4 inline-flex min-h-10 items-center gap-1.5 text-[13px] font-semibold text-primary-ink hover:text-ink">
                {askLabel ?? "Ask about this"}
                <ChevronRight className="size-4" aria-hidden />
              </button>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
