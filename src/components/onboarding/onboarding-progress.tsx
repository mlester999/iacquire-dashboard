"use client";

import type * as React from "react";
import { Check } from "lucide-react";
import { ONBOARDING_SECTIONS, type SectionId } from "@/lib/onboarding/types";
import type { Progress } from "@/lib/onboarding/engine";

type StageState = "complete" | "current" | "todo";

/**
 * "Built around you": the onboarding progress panel. It is dark navy in both themes (see `.onboarding-stages` in globals.css)
 * and is the one place that shows the current section, the question position, overall progress and save state.
 * Every figure comes from the live answers via `computeProgress`; the stage tiles jump to that section's next open question.
 */
export function OnboardingProgress({ current, progress, welcome, position, saveState, disabled, onSelect }: {
  current: SectionId;
  progress: Progress;
  welcome: boolean;
  /** "Question 4 of 47", or "Final step" on the review. */
  position: string;
  saveState: React.ReactNode;
  disabled: boolean;
  onSelect: (id: SectionId) => void;
}) {
  const section = ONBOARDING_SECTIONS.find((s) => s.id === current)!;
  const stages = ONBOARDING_SECTIONS.map((s, index) => {
    const part = progress.sections.find((item) => item.id === s.id);
    const total = part?.total ?? 0;
    const done = part?.done ?? 0;
    const complete = total > 0 && done === total && part?.requiredOutstanding === 0;
    const state: StageState = s.id === current ? "current" : complete ? "complete" : "todo";
    const status = s.id === "F" ? "Final check" : complete ? "Complete" : done > 0 || state === "current" ? `${done} of ${total}` : `${total} question${total === 1 ? "" : "s"}`;
    const spoken = s.id === "F" ? "final check" : `${complete ? "complete" : done > 0 ? "in progress" : "not started"}, ${done} of ${total} answered`;
    return { ...s, number: String(index + 1).padStart(2, "0"), total, done, complete, state, status, label: `${s.short}: ${state === "current" ? "current section, " : ""}${spoken}` };
  });

  return (
    <section aria-labelledby="onboarding-stage-title" className="onboarding-stages p-4 sm:p-5 lg:px-7 lg:pb-6 lg:pt-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-[var(--stage-accent)] lg:text-[11px]">Built around you</p>
        {saveState}
      </div>

      <div className="mt-2.5 sm:flex sm:items-end sm:justify-between sm:gap-8 lg:mt-3">
        <div className="min-w-0">
          <h2 id="onboarding-stage-title" className="text-[18px] font-semibold leading-snug tracking-[-0.02em] sm:text-[21px] lg:text-[26px] lg:leading-tight">
            {welcome ? "Let's set up your workspace." : section.title}
          </h2>
          <p className="mt-1 hidden max-w-xl text-[13.5px] leading-relaxed text-[var(--stage-ink-2)] sm:block lg:mt-1.5 lg:text-[14px]">
            {welcome ? "We'll start with the basics about your business. Everything saves as you go." : section.blurb}
          </p>
        </div>
        <p className="mt-1 flex shrink-0 items-baseline gap-2 text-[12.5px] tabular-nums sm:mt-0 sm:flex-col sm:items-end sm:gap-0.5 sm:text-right">
          <span className="font-medium text-[var(--stage-ink-2)] sm:text-[13px]">{position}</span>
          <span aria-hidden className="text-[var(--stage-muted)] sm:hidden">·</span>
          <span className="text-[var(--stage-muted)]">{progress.percent}% answered</span>
        </p>
      </div>

      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.percent}% of setup answered`}
        className="onboarding-meter mt-4 lg:mt-6"
      >
        {stages.map((stage) => (
          <span key={stage.id} data-state={stage.state} className="onboarding-meter-segment">
            <span style={{ width: `${stage.total ? (stage.done / stage.total) * 100 : 0}%` }} />
          </span>
        ))}
      </div>

      <nav aria-label="Setup sections" className="mt-3 md:mt-2">
        <ol className="grid grid-cols-3 gap-1.5 md:grid-cols-6 md:gap-2">
          {stages.map((stage) => (
            <li key={stage.id} className="min-w-0">
              <button type="button" data-state={stage.state} onClick={() => onSelect(stage.id)} disabled={disabled} aria-current={stage.state === "current" ? "step" : undefined} className="onboarding-stage">
                <span aria-hidden className="flex w-full items-center justify-between">
                  <span className="onboarding-stage-number">{stage.number}</span>
                  <StageMark state={stage.complete ? "complete" : stage.state} />
                </span>
                {/* Named from its own words, with the state said once: an aria-label that replaces visible text fails WCAG label-in-name (axe: label-content-name-mismatch). */}
                <span className="onboarding-stage-label">{stage.short}</span>
                <span className="sr-only">: {stage.label.slice(stage.short.length + 2)}</span>
                <span aria-hidden className="onboarding-stage-status hidden sm:block">
                  {stage.status}
                  {stage.state === "current" && stage.id !== "F" && <span className="hidden lg:inline"> answered</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </section>
  );
}

function StageMark({ state }: { state: StageState }) {
  return (
    <span data-state={state} className="onboarding-stage-mark">
      {state === "complete" && <Check className="size-2.5" strokeWidth={3} />}
    </span>
  );
}
