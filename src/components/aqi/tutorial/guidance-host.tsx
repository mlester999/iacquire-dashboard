"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { ContextualTip } from "@/components/aqi/tutorial/contextual-tip";
import { GuidanceCard } from "@/components/aqi/tutorial/guidance-card";
import { OnboardingNudge } from "@/components/aqi/tutorial/onboarding-nudge";
import { TutorialResumePill } from "@/components/aqi/tutorial/resume-pill";
import { bootstrapGuidance, markGuidance, restoreGuidanceFocus, syncGuidanceProgress, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

// The spotlight stage is its own chunk, kept out of the initial page bundle. It is fetched while the
// browser is idle once guidance is known to be available, and the loaded component is rendered
// directly. next/dynamic is deliberately not used here: it suspends on first render even when the
// chunk is already in memory, and React holds a revealed Suspense boundary back for 300 ms, which
// was the single largest delay between clicking "Start tour" and seeing the first spotlight.
let loadedStage: React.ComponentType | null = null;
const loadStage = () => {
  markGuidance("chunk:requested");
  return import("@/components/aqi/tutorial/tutorial-stage").then((module) => {
    loadedStage = module.TutorialStage;
    markGuidance("chunk:loaded");
    return module.TutorialStage;
  });
};

function LazyStage() {
  const state = useGuidance();
  const [Stage, setStage] = React.useState<React.ComponentType | null>(() => loadedStage);
  const wanted = state.open || (state.ready && state.tutorials.length > 0);
  React.useEffect(() => {
    if (Stage || !wanted) return;
    let cancelled = false;
    const load = () => void loadStage().then((component) => { if (!cancelled) setStage(() => component); });
    // Needed right now: fetch immediately. Otherwise wait for an idle moment.
    if (state.open) {
      load();
      return () => {
        cancelled = true;
      };
    }
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle ? window.requestIdleCallback(load, { timeout: 4000 }) : window.setTimeout(load, 1500);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [Stage, wanted, state.open]);
  if (!state.open || !Stage) return null;
  return <Stage />;
}

/**
 * Appears the instant a walkthrough is requested and stays until the walkthrough card is placed, so
 * there is always visible feedback between the click and the first spotlight.
 */
function StartingCard() {
  const state = useGuidance();
  const starting = state.phase === "starting" || (state.open && !state.stageReady && state.phase === "active");
  const [expired, setExpired] = React.useState(false);
  // Never an endless spinner: if the walkthrough card has not appeared after ten seconds, step aside.
  React.useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => setExpired(true), 10_000);
    return () => {
      window.clearTimeout(timer);
      setExpired(false);
    };
  }, [starting]);
  if (!starting || expired) return null;
  return (
    <GuidanceCard
      data-aqi-starting
      role="status"
      live="polite"
      tone="soft"
      icon={<Loader2 className="size-[18px] animate-spin" aria-hidden />}
    >
      <p className="text-[14px] font-semibold leading-snug tracking-tight text-ink">Starting your walkthrough…</p>
      {state.startingTitle || state.tutorial?.title ? <p className="mt-0.5 truncate text-[13px] text-muted">{state.startingTitle ?? state.tutorial?.title}</p> : null}
    </GuidanceCard>
  );
}

/**
 * Mounted at the application shell so a walkthrough survives client navigation between pages and
 * the AQi panel. It only loads tutorial metadata; it never blocks the page or a chat turn.
 */
export function GuidanceHost() {
  const pathname = usePathname();
  const state = useGuidance();
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    void bootstrapGuidance(pathname);
    void syncGuidanceProgress(pathname);
  }, [pathname]);
  React.useEffect(() => {
    if (wasOpen.current && !state.open) restoreGuidanceFocus();
    wasOpen.current = state.open;
  }, [state.open]);
  return (
    <>
      <LazyStage />
      <StartingCard />
      <TutorialResumePill />
      <OnboardingNudge />
      <ContextualTip />
    </>
  );
}
