"use client";

import { Check } from "lucide-react";
import { ONBOARDING_SECTIONS, type SectionId } from "@/lib/onboarding/types";
import type { Progress } from "@/lib/onboarding/engine";
import { cn } from "@/lib/utils";

export function OnboardingProgress({ current, progress, welcome, disabled, onSelect }: { current: SectionId; progress: Progress; welcome: boolean; disabled: boolean; onSelect: (id: SectionId) => void }) {
  return (
    <aside aria-label="Setup sections" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
      <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-muted">Built around you</p>
      {welcome && <p className="mt-1.5 text-[17px] font-semibold tracking-tight text-ink">Let&apos;s set up your workspace.</p>}
      <ol className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-1 lg:gap-1">
        {ONBOARDING_SECTIONS.map((section, index) => {
          const part = progress.sections.find((item) => item.id === section.id);
          const active = current === section.id;
          const completed = Boolean(part && part.total > 0 && part.done === part.total && part.requiredOutstanding === 0);
          return (
            <li key={section.id}>
              <button type="button" onClick={() => onSelect(section.id)} disabled={disabled} aria-current={active ? "step" : undefined} aria-label={`${section.short}${completed ? ", completed" : active ? ", current section" : ", upcoming"}`} className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 motion-reduce:transition-none lg:px-3 lg:text-[13px]", active ? "bg-primary-soft font-semibold text-primary-ink" : "text-muted")}>
                <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-medium", active ? "bg-primary text-white" : completed ? "bg-success-soft text-success-ink" : "bg-surface-3 text-muted")}>{completed && !active ? <Check className="size-3" /> : index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{section.short}</span>
                {part && part.total > 0 && <span aria-hidden className="hidden text-[11px] tabular-nums text-muted lg:inline">{part.done}/{part.total}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
