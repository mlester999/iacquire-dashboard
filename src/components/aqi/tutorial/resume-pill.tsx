"use client";

import * as React from "react";
import { Play, Sparkles } from "lucide-react";
import { GuidanceCard, GuidanceCloseButton, GuidanceGhostButton, GuidancePrimaryButton } from "@/components/aqi/tutorial/guidance-card";
import { dismissResume, resumeTutorial, useAqiPanelOpen, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

/** A quiet, persistent way back into a paused walkthrough. It never opens itself. */
export function TutorialResumePill() {
  const state = useGuidance();
  const panelOpen = useAqiPanelOpen();
  if (!state.resume || state.open || panelOpen || state.phase === "starting") return null;
  const { resume } = state;
  return (
    <GuidanceCard role="status" tone="soft" icon={<Sparkles className="size-[18px]" aria-hidden />}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-primary-ink">{resume.versionChanged ? "Walkthrough updated" : "Walkthrough paused"}</p>
          <p className="mt-0.5 truncate text-[14px] font-semibold tracking-tight text-ink">{resume.title}</p>
        </div>
        <GuidanceCloseButton label="Hide walkthrough reminder" onClick={dismissResume} />
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted">{resume.versionChanged ? "Restart with the published version" : `Step ${Math.min(resume.currentStep + 1, resume.stepCount)} of ${resume.stepCount}`}</p>
      <div className="mt-3 flex items-center gap-1.5">
        <GuidancePrimaryButton onClick={() => void resumeTutorial()}>
          <Play className="size-3.5" aria-hidden /> {resume.versionChanged ? "Restart" : "Resume"}
        </GuidancePrimaryButton>
        <GuidanceGhostButton onClick={dismissResume}>Not now</GuidanceGhostButton>
      </div>
    </GuidanceCard>
  );
}
