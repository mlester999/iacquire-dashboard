"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { bootstrapGuidance, syncGuidanceProgress, useGuidance } from "@/components/aqi/tutorial/tutorial-store";
import { ContextualTip } from "@/components/aqi/tutorial/contextual-tip";
import { OnboardingNudge } from "@/components/aqi/tutorial/onboarding-nudge";
import { TutorialResumePill } from "@/components/aqi/tutorial/resume-pill";

// The spotlight stage is fetched only when a walkthrough actually opens, keeping it out of the
// initial page bundle.
const TutorialStage = dynamic(() => import("@/components/aqi/tutorial/tutorial-stage").then((module) => module.TutorialStage), { ssr: false });

function LazyStage() {
  const state = useGuidance();
  if (!state.open) return null;
  return <TutorialStage />;
}

/**
 * Mounted at the application shell so a walkthrough survives client navigation between pages and
 * the AQi panel. It only loads tutorial metadata; it never blocks the page or a chat turn.
 */
export function GuidanceHost() {
  const pathname = usePathname();
  React.useEffect(() => {
    void bootstrapGuidance(pathname);
    void syncGuidanceProgress(pathname);
  }, [pathname]);
  return (
    <>
      <LazyStage />
      <TutorialResumePill />
      <OnboardingNudge />
      <ContextualTip />
    </>
  );
}
