"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowRight, Sparkles } from "lucide-react";
import { GuidanceCard, GuidanceCloseButton, GuidanceGhostButton, GuidancePrimaryButton, GuidanceQuietButton } from "@/components/aqi/tutorial/guidance-card";
import { dismissOnboardingLocally, markOnboardingOffered, setOnboardingVisible, startTutorial, useAqiPanelOpen, useGuidance } from "@/components/aqi/tutorial/tutorial-store";

/** Matches the server's quiet routes: the welcome is never offered on a chat or onboarding page. */
const QUIET_ROUTE = /^\/(chat|onboarding)(\/|$)/;
/** Wait for the page to settle before offering anything, so the prompt never competes with first paint. */
const SETTLE_TIMEOUT_MS = 1200;
const RETRY_MS = 2500;
const MAX_RETRIES = 6;

/** True while the person is typing or a modal dialog owns the screen: not the time for a welcome. */
function workflowBusy(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return true;
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"]:not([data-aqi-panel])'));
}

/**
 * Optional first-time guidance. The server decides eligibility from the person's real permissions and
 * returns it with the guidance bootstrap, so there is no second request. Every choice is remembered
 * server-side. It never auto-starts a walkthrough, never returns after "Don't show again", and waits
 * out a form being edited or a dialog being open.
 */
export function OnboardingNudge() {
  const pathname = usePathname();
  const state = useGuidance();
  const panelOpen = useAqiPanelOpen();
  const [busy, setBusy] = React.useState(false);
  const [readyPath, setReadyPath] = React.useState<string | null>(null);

  const path = pathname ?? "/";
  const offer = state.onboarding;
  // Offered at most once per page session: after it has been shown, moving to another page does not bring it back.
  const eligible = Boolean(offer?.shouldOffer && offer.recommended) && !QUIET_ROUTE.test(path) && !state.open && !state.resume && !panelOpen && state.phase !== "starting" && (!state.onboardingOffered || readyPath === path);

  React.useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    let idle = 0;
    const show = () => {
      if (cancelled) return;
      if (workflowBusy() && attempts < MAX_RETRIES) {
        attempts += 1;
        timer = window.setTimeout(show, RETRY_MS);
        return;
      }
      if (!workflowBusy()) {
        setReadyPath(path);
        markOnboardingOffered();
      }
    };
    const hasIdle = typeof window.requestIdleCallback === "function";
    if (hasIdle) idle = window.requestIdleCallback(show, { timeout: SETTLE_TIMEOUT_MS });
    else timer = window.setTimeout(show, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (hasIdle) window.cancelIdleCallback(idle);
    };
  }, [eligible, path]);

  const visible = eligible && readyPath === path;
  React.useEffect(() => {
    setOnboardingVisible(visible);
    return () => setOnboardingVisible(false);
  }, [visible]);

  if (!visible || !offer?.recommended) return null;
  const tutorial = offer.recommended;

  async function act(action: "start" | "defer" | "dismiss") {
    if (busy) return;
    setBusy(true);
    // Close immediately: the choice is saved in the background, and a failed save only means the
    // welcome may be offered again later.
    dismissOnboardingLocally();
    setOnboardingVisible(false);
    const saved = fetch("/api/aqi/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => undefined);
    if (action === "start") await Promise.all([saved, startTutorial(tutorial.slug, "onboarding")]);
    else await saved;
    setBusy(false);
  }

  return (
    <GuidanceCard role="dialog" labelledBy="aqi-welcome-title" icon={<Sparkles className="size-[18px]" aria-hidden />}>
      <div className="flex items-start justify-between gap-2">
        <p id="aqi-welcome-title" className="text-[14px] font-semibold leading-snug tracking-tight text-ink">New to iAcquireOS?</p>
        <GuidanceCloseButton label="Postpone the tour" disabled={busy} onClick={() => void act("defer")} />
      </div>
      <p className="mt-1 text-[14px] leading-relaxed text-muted">Want a quick tour? I&apos;ll show you around.</p>
      <div className="mt-3 flex items-center gap-1.5">
        <GuidancePrimaryButton disabled={busy} onClick={() => void act("start")}>
          Start tour <ArrowRight className="size-3.5" aria-hidden />
        </GuidancePrimaryButton>
        <GuidanceGhostButton disabled={busy} onClick={() => void act("defer")}>Maybe later</GuidanceGhostButton>
      </div>
      <div className="mt-2 border-t border-line pt-1.5">
        <GuidanceQuietButton disabled={busy} onClick={() => void act("dismiss")}>Don&apos;t show again</GuidanceQuietButton>
      </div>
    </GuidanceCard>
  );
}
