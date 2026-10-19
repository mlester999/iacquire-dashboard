"use client";

import * as React from "react";
import { Play, Sparkles, X } from "lucide-react";
import { dismissResume, resumeTutorial, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

/** A quiet, persistent way back into a paused walkthrough. It never opens itself. */
export function TutorialResumePill() {
  const state = useGuidance();
  if (!state.resume || state.open) return null;
  const { resume } = state;
  return (
    <div
      className="fixed z-40 w-[min(340px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-3 shadow-float"
      style={{ right: "max(12px, env(safe-area-inset-right))", bottom: "calc(max(14px, env(safe-area-inset-bottom)) + 70px)" }}
      role="status"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary"><Sparkles className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{resume.versionChanged ? "Walkthrough updated" : "Walkthrough paused"}</p>
          <p className="mt-0.5 truncate text-[12.5px] font-medium text-ink">{resume.title}</p>
          <p className="text-[11px] text-muted">{resume.versionChanged ? "Restart with the published version" : `Step ${Math.min(resume.currentStep + 1, resume.stepCount)} of ${resume.stepCount}`}</p>
          <div className="mt-2 flex items-center gap-1.5">
            <button type="button" onClick={() => void resumeTutorial()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11.5px] font-semibold text-white hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              <Play className="size-3" /> {resume.versionChanged ? "Restart" : "Resume"}
            </button>
            <button type="button" onClick={dismissResume} className="inline-flex h-8 items-center rounded-lg px-2 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-ink">Not now</button>
          </div>
        </div>
        <button type="button" onClick={dismissResume} aria-label="Hide walkthrough reminder" className="-mr-1 -mt-1 flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"><X className="size-3.5" /></button>
      </div>
    </div>
  );
}
